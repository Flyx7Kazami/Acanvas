import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
export function prepare({ appBundle = '/Applications/ChatGPT.app', canvasUrl, previewOrigin }) {
    const adapter = path.dirname(fileURLToPath(import.meta.url));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'acanvas-native-codex-'));
    const archive = path.join(appBundle, 'Contents/Resources/app.asar');
    const fd = fs.openSync(archive, 'r');
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const headerBytes = Buffer.alloc(prefix.readUInt32LE(12));
    fs.readSync(fd, headerBytes, 0, headerBytes.length, 16);
    const header = JSON.parse(headerBytes.toString());
    const dataOffset = 8 + prefix.readUInt32LE(4);
    const entries = [];
    function walk(tree, parent = '') {
        for (const [name, item] of Object.entries(tree.files ?? {})) {
            const relative = parent + name;
            if (item.files)
                walk(item, relative + '/');
            else
                entries.push([relative, item]);
        }
    }
    walk(header);
    function bytes(relative, item) {
        if (item.unpacked)
            return fs.readFileSync(archive + '.unpacked/' + relative);
        const result = Buffer.alloc(item.size);
        fs.readSync(fd, result, 0, result.length, dataOffset + Number(item.offset));
        return result;
    }
    const packageEntry = entries.find(([name]) => name === 'package.json');
    const applicationPackage = JSON.parse(bytes(...packageEntry).toString());
    let extractedFiles = 0;
    let extractedBytes = 0;
    for (const [relative, item] of entries) {
        if (!relative.startsWith('webview/'))
            continue;
        const target = path.join(workspace, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const data = bytes(relative, item);
        fs.writeFileSync(target, data);
        if (!fs.readFileSync(target).equals(data))
            throw Error(`Source copy failed: ${relative}`);
        extractedFiles++;
        extractedBytes += data.length;
    }
    fs.closeSync(fd);
    const webview = path.join(workspace, 'webview');
    const index = fs.readFileSync(path.join(webview, 'index.html'), 'utf8');
    const entryModule = index.match(/<script type="module" crossorigin src="([^"]+)"/)[1];
    const sharedModule = './assets/' + fs.readdirSync(path.join(webview, 'assets')).find(name => /^app-shared-[a-f0-9]+\.js$/.test(name));
    const shared = fs.readFileSync(path.join(webview, sharedModule), 'utf8');
    const exportedAlias = name => shared.match(new RegExp(`\\b${name} as ([\\w$]+)[,}]`))[1];
    // These three native RPC symbols are observed in the installed 26.1007.30912 renderer.
    const rpc = { initialize: exportedAlias('yF'), target: exportedAlias('vF'), connect: exportedAlias('nIt') };
    const config = { canvasUrl, previewOrigin, entryModule, sharedModule, rpc, applicationVersion: applicationPackage.version };
    fs.writeFileSync(path.join(webview, 'fixture-config.json'), JSON.stringify(config, null, 2));
    fs.copyFileSync(path.join(adapter, 'fixture.js'), path.join(webview, 'fixture.js'));
    for (const name of ['serve.cjs', 'electron-main.cjs', 'native-preload.cjs'])
        fs.copyFileSync(path.join(adapter, name), path.join(workspace, name));
    const plist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(appBundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    const source = {
        appBundle, bundleIdentifier: plist('CFBundleIdentifier'), version: applicationPackage.version,
        build: plist('CFBundleVersion'), electron: applicationPackage.devDependencies.electron,
        renderer: 'webview/index.html', entryModule, sharedModule, rpc,
        extractedFiles, extractedBytes, copiedBytesVerified: true,
        data: 'Synthetic Slow Signal conversations, settings, host responses, and isolated Acanvas example.',
        originalAssets: 'Kept in this temporary workspace. No application assets are included in the Acanvas repository.',
    };
    fs.writeFileSync(path.join(workspace, 'source.json'), JSON.stringify(source, null, 2));
    fs.writeFileSync(path.join(workspace, 'runtime-package.json'), JSON.stringify({ private: true, engines: { node: '>=24' }, dependencies: { electron: source.electron } }, null, 2));
    return { workspace, source };
}
