// scripts/update_rules.js

const fs = require('fs');
const path = require('path');

// 仓库配置
const REPO = 'MetaCubeX/meta-rules-dat';
const BRANCH = 'sing';
const BASE_URL = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}`; // 去掉了后面的路径，因为后面要动态拼

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const HEADERS = {
    'User-Agent': 'Singularity-Bot',
    ...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {})
};

function formatCommitTime(isoString) {
    return isoString.replace(/[-:TZ]/g, '');
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        return await res.json();
    } catch (error) {
        console.warn(`⚠️ Fetch warning for ${url}: ${error.message}`);
        return null;
    }
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
 * @param {Array} treeItems GitHub Tree 数组
 * @param {String} prefix 路径前缀，例如 'geo/' 或 'geo-lite/'
 */
function buildRulesIndex(treeItems, prefix) {
    const ruleMap = new Map();

    for (const item of treeItems) {
        if (item.type !== 'blob') continue;
        // 🔥 关键修正：根据传入的前缀过滤 (geo/ 或 geo-lite/)
        if (!item.path.startsWith(prefix)) continue;

        // 截取相对路径: geo/geoip/cn.srs -> geoip/cn.srs
        const relPath = item.path.slice(prefix.length);
        
        // 判断文件类型
        let fileType = '';
        if (relPath.endsWith('.srs')) fileType = 'srs'; // 建议用 srs 而不是 sys
        else if (relPath.endsWith('.json')) fileType = 'json';
        else continue;

        // 提取名称: geoip/cn.srs -> cn
        // 注意：这里需要去掉前面的 geoip/ 或 geosite/ 目录
        const parts = relPath.split('/');
        if (parts.length < 2) continue; // 忽略根目录文件
        
        const category = parts[0]; // geoip 或 geosite
        const filename = parts[1]; // cn.srs
        const name = filename.replace(/\.(srs|json)$/, '');

        const record = ruleMap.get(name) || {
            name,
            fileTypes: new Set(),
            geoTypes: new Set(),
            files: [] // 记录具体文件路径，方便客户端直接下载
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
                path: item.path, // 这里存完整路径: geo-lite/geoip/cn.srs
                fileType,
                geoType
            });
        }

        ruleMap.set(name, record);
    }

    // 转为数组并排序
    return Array.from(ruleMap.values())
        .map((record) => ({
            name: record.name,
            fileType: resolveFileType(record.fileTypes),
            geoType: resolveGeoType(record.geoTypes),
            // 这里可选：是否把所有文件列表也放在 JSON 里？
            // 你的代码里 fullOutput 放了 files，liteOutput 没放，这个设计挺好
            files: record.files.sort((a, b) => a.path.localeCompare(b.path)) 
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
    try {
        console.log(`🌍 开始处理规则: ${REPO}...`);

        // 1. 获取最新 Commit
        const commitUrl = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
        const commitData = await fetchJson(commitUrl);
        if (!commitData) throw new Error('Commit fetch failed');

        const newVersion = formatCommitTime(commitData.commit.committer.date);

        // 2. 检查本地版本 (只需检查一个文件即可)
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

        // 3. 拉取规则树
        const treeUrl = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
        const treeData = await fetchJson(treeUrl);
        if (!treeData || !Array.isArray(treeData.tree)) throw new Error('Rules tree fetch failed');

        // 4. 🔥 分别生成 Lite 和 Full 索引
        // geo-lite/ -> lite.json (手机端/轻量版)
        const liteRules = buildRulesIndex(treeData.tree, 'geo-lite/');
        
        // geo/ -> full.json (全量版)
        const fullRules = buildRulesIndex(treeData.tree, 'geo/');

        if (liteRules.length === 0 && fullRules.length === 0) {
            throw new Error('No rules found! Check path prefix.');
        }

        // 5. 写入输出
        if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });

        // 生成 lite.json
        const liteOutput = {
            version: newVersion,
            // 客户端拼接: baseUrl + "/" + file.path
            baseUrl: BASE_URL, 
            rules: liteRules.map(r => ({
                name: r.name,
                fileType: r.fileType,
                geoType: r.geoType,
                // 这里我们简化 Lite 版的 JSON，不放 files 详情，只放概览
                // 客户端自己拼路径: geo-lite/{geoType}/{name}.srs
            }))
        };

        // 生成 full.json (包含更全的 geo 目录规则)
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