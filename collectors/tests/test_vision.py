import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision_service import FrameGate, VisionEngine, parse_prediction, unknown


class FakeImage:
    def close(self):
        pass


class PassingGate:
    def inspect(self, raw):
        return FakeImage(), {"accepted": True, "reason": "ok"}


class FakeLocal:
    calls = 0
    def classify(self, image):
        self.calls += 1
        return {"scene": "reading", "confidence": 0.82, "objects": [], "backend": "local-clip", "observed": True}
    def health(self):
        return {"ready": True, "error": None}


class PredictionTests(unittest.TestCase):
    def test_invalid_or_invented_classes_rejected(self):
        for content in ["not json", '{"scene":"distracted","confidence":0.9}',
                        '{"scene":"reading","confidence":true}',
                        '{"scene":"reading","confidence":1.1}',
                        '{"scene":"reading","confidence":NaN}',
                        '{"scene":"reading","confidence":0.8,"objects":"book"}']:
            with self.subTest(content=content), self.assertRaises((ValueError, TypeError)):
                parse_prediction(content)

    def test_fenced_json_only_and_bounded_objects(self):
        result = parse_prediction('```json\n{"scene":"writing","confidence":0.8,"objects":["pen"]}\n```')
        self.assertEqual(result["scene"], "writing")
        self.assertEqual(result["objects"], ["pen"])

    def test_local_only_never_calls_cloud(self):
        with patch.dict("os.environ", {"FOCUS_VISION_BACKEND": "cloud"}):
            engine = VisionEngine(local=FakeLocal(), gate=PassingGate())
        with patch.object(engine, "cloud", side_effect=AssertionError("image sent to cloud")) as cloud:
            result = engine.classify(b"frame", local_only=True)
        cloud.assert_not_called()
        self.assertEqual(result["backend"], "local-clip")

    def test_cloud_error_falls_back_to_actual_local(self):
        with patch.dict("os.environ", {"FOCUS_VISION_BACKEND": "cloud"}):
            engine = VisionEngine(local=FakeLocal(), gate=PassingGate())
        with patch.object(engine, "cloud", side_effect=TimeoutError()):
            result = engine.classify(b"frame", local_only=False)
        self.assertEqual(result["scene"], "reading")
        self.assertEqual(result["fallbackReason"], "cloud_unavailable_or_invalid_response")

    def test_missing_local_returns_no_observation(self):
        local = FakeLocal()
        local.classify = lambda image: unknown("local_model_unavailable", "local-clip")
        with patch.dict("os.environ", {"FOCUS_VISION_BACKEND": "cloud"}):
            engine = VisionEngine(local=local, gate=PassingGate())
        with patch.object(engine, "cloud", side_effect=TimeoutError()):
            result = engine.classify(b"frame", local_only=False)
        self.assertFalse(result["observed"])
        self.assertEqual(result["confidence"], 0)
        self.assertEqual(result["reason"], "local_model_unavailable")

    def test_filtered_frame_does_not_invoke_models(self):
        local = FakeLocal()
        class RejectGate:
            def inspect(self, raw):
                return None, {"accepted": False, "reason": "too_dark"}
        engine = VisionEngine(local=local, gate=RejectGate())
        result = engine.classify(b"frame")
        self.assertFalse(result["observed"])
        self.assertEqual(local.calls, 0)


class GateTests(unittest.TestCase):
    def image(self, fill=None):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow not installed")
        image = Image.new("RGB", (64, 64))
        image.putdata([((0 if (x//4 + y//4) % 2 else 200),) * 3 if fill is None else (fill,) * 3
                       for y in range(64) for x in range(64)])
        data = io.BytesIO()
        image.save(data, format="PNG")
        return data.getvalue()

    def test_dark_and_uniform_images_do_not_become_activity(self):
        gate = FrameGate()
        self.assertEqual(gate.inspect(self.image(0), now=0)[1]["reason"], "too_dark")
        self.assertEqual(gate.inspect(self.image(120), now=0)[1]["reason"], "blurred_or_occluded")

    def test_duplicate_filter_does_not_block_periodic_observations(self):
        gate = FrameGate()
        raw = self.image()
        image, quality = gate.inspect(raw, now=0)
        self.assertTrue(quality["accepted"])
        image.close()
        self.assertFalse(gate.inspect(raw, now=2)[1]["accepted"])
        image, quality = gate.inspect(raw, now=20)
        self.assertTrue(quality["accepted"])
        image.close()


if __name__ == "__main__":
    unittest.main()
