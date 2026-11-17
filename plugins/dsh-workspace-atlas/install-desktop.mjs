import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const PKG_NAME = '@local/dsh-workspace-atlas';
const LINK_SPEC = `link:${PLUGIN_DIR}`;

for (const profileName of ['desktop', 'web']) {
  const profileDir = join(HOME, '.dsh', 'profiles', profileName);
  const pkgPath = join(profileDir, 'package.json');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies[PKG_NAME] = LINK_SPEC;

  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) {
    pkg.dsh.profile.bundles.push(PKG_NAME);
  }

  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b))
  );

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const localScopeDir = join(profileDir, 'node_modules', '@local');
  mkdirSync(localScopeDir, { recursive: true });
  const linkPath = join(localScopeDir, 'dsh-workspace-atlas');

  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isFile() || st.isDirectory()) {
      unlinkSync(linkPath);
    }
  } catch {
    // does not exist yet
  }
  symlinkSync(PLUGIN_DIR, linkPath, 'dir');

  // Keep pnpm-workspace.yaml overrides in sync if present
  const wsYamlPath = join(profileDir, 'pnpm-workspace.yaml');
  if (existsSync(wsYamlPath)) {
    const relLinkSpec = `link:${relative(profileDir, PLUGIN_DIR)}`;
    const wsText = readFileSync(wsYamlPath, 'utf8');
    if (wsText.includes('overrides:')) {
      const overrideLine = `  '${PKG_NAME}': ${relLinkSpec}`;
      const existingRe = new RegExp(`^\\s*['"]?${PKG_NAME.replace('/', '\\/')}['"]?:.*$`, 'm');
      const updated = existingRe.test(wsText)
        ? wsText.replace(existingRe, overrideLine)
        : wsText.replace('overrides:\n', `overrides:\n${overrideLine}\n`);
      writeFileSync(wsYamlPath, updated, 'utf8');
    }
  }

  console.log(`Successfully linked ${PKG_NAME} -> ${PLUGIN_DIR} in ${profileDir}`);
}
