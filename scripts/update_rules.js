// scripts/update_rules.js

const fs = require('fs');
const path = require('path');

// 仓库配置
const REPO = 'MetaCubeX/meta-rules-dat';
const BRANCH = 'sing';
const BASE_URL = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`; 

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const HEADERS = {
    'User-Agent': 'Singularity-Bot',
    ...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {})
};

function formatCommitTime(isoString) {
    return isoString.replace(/[-:TZ]/g, '');
}

// 🔥 辅助函数：延时
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 🔥 升级版：带重试机制的 Fetch
async function fetchJson(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, { headers: HEADERS });
            
            // 如果成功，直接返回
            if (res.ok) {
                return await res.json();
            }

            // 如果是 404，说明文件不存在，不需要重试，直接返回 null
            if (res.status === 404) {
                console.warn(`⚠️ Resource not found (404): ${url}`);
                return null;
            }

            // 如果是 5xx (服务端错误) 或 403 (限流)，抛出错误触发重试
            const msg = `Status ${res.status} ${res.statusText}`;
            throw new Error(msg);

        } catch (error) {
            console.warn(`⚠️ Fetch attempt ${i + 1}/${retries} failed for ${url}: ${error.message}`);
            
            // 如果是最后一次尝试，抛出异常让主程序处理
            if (i === retries - 1) {
                console.error(`❌ All retry attempts failed for ${url}`);
                return null;
            }
            
            // 等待一段时间后重试 (1s, 2s, ...)
            await sleep(1000 * (i + 1));
        }
    }
    return null;
}

function resolveFileType(typeSet) {
    if (typeSet.has('srs') && typeSet.has('json')) return 'all';
    if (typeSet.has('json')) return 'json';
    return 'srs';
}

function resolveGeoType(typeSet) {
    if (typeSet.has('ip') && typeSet.has('site')) return 'all';
    if (typeSet.has('ip')) return 'ip';
    if (typeSet.has('site')) return 'site';
    return 'all';
}

/**
 * 构建索引的核心函数
 */
function buildRulesIndex(treeItems, prefix) {
    const ruleMap = new Map();

    for (const item of treeItems) {
        if (item.type !== 'blob') continue;
        // 过滤前缀
        if (!item.path.startsWith(prefix)) continue;

        // 截取相对路径
        const relPath = item.path.slice(prefix.length);
        
        // 判断文件类型
        let fileType = '';
        if (relPath.endsWith('.srs')) fileType = 'srs';
        else if (relPath.endsWith('.json')) fileType = 'json';
        else continue;

        // 提取名称
        const parts = relPath.split('/');
        if (parts.length < 2) continue; // 忽略根目录文件
        
        const category = parts[0]; // geoip 或 geosite
        const filename = parts[1]; // cn.srs
        const name = filename.replace(/\.(srs|json)$/, '');

        const record = ruleMap.get(name) || {
            name,
            fileTypes: new Set(),
            geoTypes: new Set(),
            files: []
        };

        record.fileTypes.add(fileType);

        let geoType = '';
        if (category.includes('geoip')) {
            record.geoTypes.add('ip');
            geoType = 'ip';
        } else if (category.includes('geosite')) {
            record.geoTypes.add('site');
            geoType = 'site';
        }

        if (geoType) {
            record.files.push({
                path: item.path,
                fileType,
                geoType
            });
        }

        ruleMap.set(name, record);
    }

    return Array.from(ruleMap.values())
        .map((record) => ({
            name: record.name,
            fileType: resolveFileType(record.fileTypes),
            geoType: resolveGeoType(record.geoTypes),
            files: record.files.sort((a, b) => a.path.localeCompare(b.path)) 
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// 自动寻找目录前缀 (这部分你的代码写得很好，保留)
function findRulesPrefix(treeItems, targetDir) {
    // 增加边界检查，防止正则报错
    if (!treeItems || treeItems.length === 0) return '';
    
    const targetMarker = `${targetDir}/`;
    // 正则匹配: 必须包含 geoip 或 geosite 且以 .srs 或 .json 结尾
    const matcher = new RegExp(`(?:^|/)${targetDir}/(geoip|geosite)/.+\\.(srs|json)$`);
    
    for (const item of treeItems) {
        if (item.type !== 'blob') continue;
        if (!matcher.test(item.path)) continue;
        const index = item.path.lastIndexOf(targetMarker);
        if (index >= 0) return item.path.slice(0, index) + targetMarker;
    }
    return '';
}

async function main() {
    try {
        console.log(`🌍 开始处理规则: ${REPO}...`);

        // 1. 获取最新 Commit (带重试)
        const commitUrl = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
        const commitData = await fetchJson(commitUrl);
        if (!commitData) throw new Error('Commit fetch failed after retries');

        const newVersion = formatCommitTime(commitData.commit.committer.date);

        // 2. 检查本地版本
        const rulesDir = path.join(__dirname, '../static/rules');
        const versionPath = path.join(rulesDir, 'rule.version');
        let currentVersion = '';
        if (fs.existsSync(versionPath)) {
            try { currentVersion = fs.readFileSync(versionPath, 'utf-8').trim(); } catch (e) {}
        }
        
        if (currentVersion === newVersion) {
            console.log(`✅ 版本无变化 (${newVersion})，跳过更新。`);
            return;
        }

        // 3. 拉取规则树 (带重试)
        const treeUrl = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
        const treeData = await fetchJson(treeUrl);
        if (!treeData || !Array.isArray(treeData.tree)) throw new Error('Rules tree fetch failed after retries');

        // 4. 生成 Lite 和 Full 索引
        const litePrefix = findRulesPrefix(treeData.tree, 'geo-lite');
        const fullPrefix = findRulesPrefix(treeData.tree, 'geo');

        // 增加日志方便调试
        console.log(`   Lite Prefix: "${litePrefix}"`);
        console.log(`   Full Prefix: "${fullPrefix}"`);

        const liteRules = litePrefix ? buildRulesIndex(treeData.tree, litePrefix) : [];
        const fullRules = fullPrefix ? buildRulesIndex(treeData.tree, fullPrefix) : [];

        if (liteRules.length === 0 && fullRules.length === 0) {
            throw new Error('No rules found! Check path prefix logic.');
        }

        // 5. 写入输出
        if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });

        const liteOutput = {
            version: newVersion,
            baseUrl: BASE_URL, 
            rules: liteRules.map(r => ({
                name: r.name,
                fileType: r.fileType,
                geoType: r.geoType
            }))
        };

        const fullOutput = {
            version: newVersion,
            baseUrl: BASE_URL,
            rules: fullRules.map(r => ({
                name: r.name,
                fileType: r.fileType,
                geoType: r.geoType
            }))
        };

        fs.writeFileSync(path.join(rulesDir, 'lite.json'), JSON.stringify(liteOutput, null, 2));
        fs.writeFileSync(path.join(rulesDir, 'full.json'), JSON.stringify(fullOutput, null, 2));
        fs.writeFileSync(versionPath, newVersion);

        // 通知 Action 提交
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `update_json=true\n`);
        }

        console.log(`✅ 规则已更新: ${newVersion}`);
        console.log(`   Lite: ${liteRules.length} 条, Full: ${fullRules.length} 条`);

    } catch (error) {
        console.error('❌ 规则脚本执行出错:', error);
        process.exit(1);
    }
}

main();