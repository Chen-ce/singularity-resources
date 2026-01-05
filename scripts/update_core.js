// Update core.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- 配置区域 ---
// 你的资源仓库（公开库）的用户名和仓库名，用于生成下载链接
// 在 GitHub Action 运行时，我们会尝试从环境变量取，取不到就用默认值
const RESOURCE_REPO = process.env.RESOURCE_REPO || 'Chen-ce/singularity-resources';
const HEADERS = {
    'User-Agent': 'Singularity-Bot',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
};

// --- 辅助函数 ---
function readLocalJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
        console.warn(`⚠️ Read warning for ${filePath}: ${error.message}`);
        return null;
    }
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
            throw new Error(`Fetch failed: ${res.statusText}`);
        }
        return await res.json();
    } catch (error) {
        console.warn(`⚠️ Fetch warning for ${url}: ${error.message}`);
        return null;
    }
}

/**
 * 全能解析：支持 Windows/MacOS 的 Legacy 版本
 * 目标：将所有兼容版统一映射为架构后缀 "-legacy"
 * 映射逻辑：
 * - windows-amd64-legacy-windows-7 -> windows / amd64-legacy
 * - darwin-amd64-legacy-macos-11   -> macos   / amd64-legacy
 * - linux-mips-softfloat           -> linux   / mips-softfloat
 */
function parseAsset(assetName) {
    // 1. 🚫 仅过滤完全无关的文件
    if (
        assetName.includes('android') ||
        assetName.includes('ios') ||
        assetName.includes('sbom') ||
        assetName.endsWith('.deb') ||
        assetName.endsWith('.rpm') ||
        assetName.endsWith('.apk') ||
        assetName.endsWith('.ipk')
    ) {
        return null;
    }

    // 2. 🎯 去除前后缀后，从左向右解析，避免被变体里的系统名干扰
    if (!assetName.startsWith('sing-box-')) return null;
    if (!assetName.endsWith('.tar.gz') && !assetName.endsWith('.zip')) return null;
    const baseName = assetName
        .replace(/^sing-box-/, '')
        .replace(/\.(tar\.gz|zip)$/, '');
    const parts = baseName.split('-');

    const osList = ['windows', 'darwin', 'linux', 'freebsd'];
    const osIndex = parts.findIndex((part) => osList.includes(part));
    if (osIndex === -1) return null;

    let os = parts[osIndex];
    let arch = parts[osIndex + 1];
    if (!arch) return null;
    const variant = parts.slice(osIndex + 2).join('-') || null;

    // 3. 🔄 系统名称标准化
    if (os === 'darwin') os = 'macos';
    if (!['windows', 'macos', 'linux', 'freebsd'].includes(os)) return null;

    // 4. 🔥 架构变体标准化 (关键逻辑)
    if (variant) {
        // 只要变体里包含 'legacy'，不管后面跟的是 windows-7 还是 macos-11，统一叫 legacy
        if (variant.includes('legacy')) {
            arch = `${arch}-legacy`;
        }
        // 处理 softfloat (Linux MIPS 常见)
        else if (variant.includes('softfloat')) {
            arch = `${arch}-softfloat`;
        }
        // 其他情况（防止未来出新变体），直接拼上去
        else {
            arch = `${arch}-${variant}`;
        }
    }

    return { os, arch, filename: assetName };
}

/**
 * 核心处理逻辑：下载 -> 解压 -> 清洗 -> 打包
 */
function processChannel(releaseData, channelName, distBaseDir) {
    console.log(`\n🏗️ [${channelName}] 检测到新版本: ${releaseData.tag_name}，开始处理...`);
    
    const downloadMap = {};
    const channelDistDir = path.join(distBaseDir, channelName);


    // 重建输出目录
    if (fs.existsSync(channelDistDir)) fs.rmSync(channelDistDir, { recursive: true });
    fs.mkdirSync(channelDistDir, { recursive: true });

    // 临时工作区
    const tempDir = path.join(__dirname, `../temp_${channelName}`);
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
    fs.mkdirSync(tempDir);


    for (const asset of releaseData.assets) {
        const info = parseAsset(asset.name);
        if (!info) continue;

        console.log(`   👉 处理: ${info.os} - ${info.arch}`);
        const rawFile = path.join(tempDir, asset.name);

        // 1. 下载
        try {
            execSync(`curl -L -s -o "${rawFile}" "${asset.browser_download_url}"`);
        } catch (e) {
            console.error(`   ❌ 下载失败: ${asset.name}`);
            continue;
        }


        // 2. 解压
        const extractDir = path.join(tempDir, `ext_${info.os}_${info.arch}`);
        fs.mkdirSync(extractDir);
        const cmd = asset.name.endsWith('.zip') 
            ? `unzip -q "${rawFile}" -d "${extractDir}"`
            : `tar -xzf "${rawFile}" -C "${extractDir}"`;
        execSync(cmd);

        // 3. 寻找二进制 (递归查找)
        const binName = info.os === 'windows' ? 'sing-box.exe' : 'sing-box';
        let binPath = '';
        try {
            binPath = execSync(`find "${extractDir}" -name "${binName}" -type f`).toString().trim();
        } catch(e) {}

        if (!binPath) {
            console.warn(`   ⚠️ 未找到二进制文件，跳过: ${asset.name}`);
            continue;
        }

        // 4. 搬运 & 赋权
        const stagingDir = path.join(tempDir, `stage_${info.os}_${info.arch}`);
        fs.mkdirSync(stagingDir);
        const destBin = path.join(stagingDir, binName);
        fs.renameSync(binPath, destBin);
        if (info.os !== 'windows') execSync(`chmod +x "${destBin}"`);

        // 5. 统一打包为 ZIP
        const cleanZipName = `core-${info.os}-${info.arch}.zip`;
        const finalZipPath = path.join(channelDistDir, cleanZipName);
        execSync(`cd "${stagingDir}" && zip -q -r "${finalZipPath}" .`);

        // 6. 生成链接
        const url = `https://github.com/${RESOURCE_REPO}/releases/download/${releaseData.tag_name}/${cleanZipName}`;
        
        if (!downloadMap[info.os]) downloadMap[info.os] = {};
        downloadMap[info.os][info.arch] = url;
    }


    // 清理临时文件
    fs.rmSync(tempDir, { recursive: true });

    return {
        version: releaseData.tag_name.replace(/^v/, ''),
        tag: releaseData.tag_name, // 保留 v 前缀用于 Release
        downloads: downloadMap
    };
}



async function main() {
    try {
        console.log('📡 正在检查版本信息...');

        // 1. 获取线上当前的 core_info.json (作为基准)
        // 注意：这里读取的是 CDN，而不是本地文件，确保是与线上对比
        const currentInfoPath = path.join(__dirname, '../static/core_info.json');
        const currentInfo = readLocalJson(currentInfoPath) || {};
        const currentStableVer = currentInfo.stable?.tag;
        const currentAlphaVer = currentInfo.alpha?.tag;


        // 2. 获取 Sing-box 官方最新信息
        const stableRelease = await fetchJson('https://api.github.com/repos/SagerNet/sing-box/releases/latest');
        const allReleases = await fetchJson('https://api.github.com/repos/SagerNet/sing-box/releases?per_page=10');
        const alphaRelease = allReleases.find(r => r.prerelease === true);

        // 准备结果对象
        // 如果没有更新，直接沿用旧数据，防止数据丢失
        const output = {
            updated_at: new Date().toISOString(),
            stable: currentInfo.stable || {},
            alpha: currentInfo.alpha || {}
        };

        const distBaseDir = path.join(__dirname, '../dist');
        let hasUpdate = false;

        // --- 3. 比对 Stable ---
        if (stableRelease && stableRelease.tag_name !== currentStableVer) {
            output.stable = processChannel(stableRelease, 'stable', distBaseDir);
            hasUpdate = true;

            // 写入 Output 变量，通知 GitHub Action 发 Stable Release
            if (process.env.GITHUB_OUTPUT) {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `do_stable=true\n`);
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `stable_tag=${stableRelease.tag_name}\n`);
            }
        } else {
            console.log(`✅ Stable 版无变化 (${currentStableVer})`);
        }

        // --- 4. 比对 Alpha ---
        const currentAlphaDownloadsEmpty = !currentInfo.alpha?.downloads || Object.keys(currentInfo.alpha.downloads).length === 0;
        const alphaNeedsUpdate = currentAlphaDownloadsEmpty || (alphaRelease && alphaRelease.tag_name !== currentAlphaVer);
        let alphaSource = alphaRelease;
        if (!alphaSource && currentAlphaVer) {
            alphaSource = await fetchJson(`https://api.github.com/repos/SagerNet/sing-box/releases/tags/${currentAlphaVer}`);
        }

        if (alphaSource && alphaNeedsUpdate) {
            output.alpha = processChannel(alphaSource, 'alpha', distBaseDir);
            hasUpdate = true;

            // 写入 Output 变量，通知 GitHub Action 发 Alpha Release
            if (process.env.GITHUB_OUTPUT) {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `do_alpha=true\n`);
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `alpha_tag=${alphaSource.tag_name}\n`);
            }
        } else {
            console.log(`✅ Alpha 版无变化 (${currentAlphaVer})`);
        }

        // --- 5. 决策：是否保存 JSON ---
        if (hasUpdate) {
            console.log('💾 检测到更新，正在写入 static/core_info.json ...');
            const staticDir = path.join(__dirname, '../static');
            if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });

            fs.writeFileSync(path.join(staticDir, 'core_info.json'), JSON.stringify(output, null, 2));

            // 通知 Action 需要提交代码
            if (process.env.GITHUB_OUTPUT) {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `update_json=true\n`);
            }
        } else {
            console.log('🎉 所有版本均为最新，无需操作。');
        }

    } catch (error) {
        console.error('❌ 脚本执行出错:', error);
        process.exit(1);
    }
}

main();
