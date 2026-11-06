#!/usr/bin/env python3
"""Explicit model download. Never invoked automatically by the camera or service."""
import argparse
from transformers import CLIPModel, CLIPProcessor

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--model", default="openai/clip-vit-base-patch32")
parser.add_argument("--output", default=None, help="Optional offline model directory")
args = parser.parse_args()
processor = CLIPProcessor.from_pretrained(args.model)
model = CLIPModel.from_pretrained(args.model)
if args.output:
    processor.save_pretrained(args.output)
    model.save_pretrained(args.output)
print("Model prepared. Start vision_service.py; inference uses local_files_only=True.")
