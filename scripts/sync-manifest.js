const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');
const yamlPath = path.join(root, 'slack-app-manifest.yml');
const jsonPath = path.join(root, 'slack-app-manifest.json');

function syncManifest() {
  const yamlContent = fs.readFileSync(yamlPath, 'utf8');
  const parsed = YAML.parse(yamlContent);
  const nextJson = `${JSON.stringify(parsed, null, 2)}\n`;

  let currentJson = '';
  if (fs.existsSync(jsonPath)) {
    currentJson = fs.readFileSync(jsonPath, 'utf8');
  }

  if (currentJson === nextJson) {
    console.log('slack-app-manifest.json already up to date');
    return;
  }

  fs.writeFileSync(jsonPath, nextJson, 'utf8');
  console.log('Updated slack-app-manifest.json from slack-app-manifest.yml');
}

syncManifest();