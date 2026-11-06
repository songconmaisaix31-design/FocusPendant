import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Used through shell command substitution; never log this credential.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=process.env.FOCUS_REMOTE_CONFIG||path.join(process.env.FOCUS_DATA_DIR||path.join(root,'data'),'remote-config.json');
const token=process.env.FOCUS_TOKEN||(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).ownerToken:'');
process.stdout.write(token||'');
