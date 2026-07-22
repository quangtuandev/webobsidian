import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { LocalStorageProvider } from '../services/storage/local.js';
import { R2StorageProvider } from '../services/storage/r2.js';

async function main() {
  console.log('🚀 Starting migration of Vault & System Data to Cloudflare R2...');

  const local = new LocalStorageProvider();
  const r2 = new R2StorageProvider();

  // 1. Migrate Vault files
  console.log('\n📁 Step 1: Uploading Vault Notes & Attachments...');
  const tree = await local.listTree();
  let totalFiles = 0;
  let migrated = 0;

  async function walkAndUpload(node: any) {
    if (node.type === 'file') {
      totalFiles++;
      const relPath = node.path;
      console.log(`[${migrated + 1}] Uploading Vault File: ${relPath}`);
      try {
        const buf = await local.readFileBuffer(relPath);
        await r2.writeFileBuffer(relPath, buf);
        migrated++;
        console.log(` ✅ Uploaded: ${relPath}`);
      } catch (err: any) {
        console.error(` ❌ Failed to upload ${relPath}:`, err?.message || err);
      }
    } else if (node.children) {
      for (const child of node.children) {
        await walkAndUpload(child);
      }
    }
  }

  if (tree.children) {
    for (const child of tree.children) {
      await walkAndUpload(child);
    }
  }

  // 2. Migrate System Data files (settings.json, shares.json, uistate.json, qmd-index.json)
  console.log('\n⚙️ Step 2: Uploading System Data & Config files to .system/ on R2...');
  const systemFiles = ['settings.json', 'shares.json', 'uistate.json', 'qmd-index.json'];

  for (const sysFile of systemFiles) {
    const absPath = path.join(config.dataDir, sysFile);
    const r2Key = `.system/${sysFile}`;
    try {
      const content = await fs.readFile(absPath);
      await r2.writeFileBuffer(r2Key, content);
      console.log(` ✅ Uploaded System File: ${sysFile} → R2 key: ${r2Key}`);
    } catch (err) {
      console.log(` ℹ️ System file ${sysFile} not found locally, skipped.`);
    }
  }

  console.log(`\n🎉 Migration completed successfully!`);
  console.log(`   - Vault Files: ${migrated}/${totalFiles} uploaded.`);
  console.log(`   - System Data: Backup saved to R2 under .system/`);
}

main().catch((err) => {
  console.error('Fatal error during migration:', err);
  process.exit(1);
});
