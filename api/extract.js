const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Vercel Serverless Function Edge Timeout Extension Config
export const config = {
    maxDuration: 60,
};

async function fetchImageAsBase64(url) {
    if (!url) return null;
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
            }
        });
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const mimeType = response.headers.get('content-type') || 'image/jpeg';
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (e) { return null; }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const clientPwd = req.headers['x-bot-password'];
    const serverPwd = process.env.BOT_PASSWORD; 
    if (serverPwd && clientPwd !== serverPwd) {
        return res.status(401).json({ error: '通行码错误或登录失效' });
    }

    const { urls, options } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: '未识别到有效的 X 链接' });
    }

    try {
        const prefix = process.env.BOT_TEXT_PREFIX || "";
        const suffix = process.env.BOT_TEXT_SUFFIX || "";
        
        let model = null;
        if (options.needTranslation) {
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
            if (GEMINI_API_KEY) {
                const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
                model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            }
        }

        const processSingleUrl = async (link) => {
            try {
                const match = link.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/);
                if (!match) throw new Error('链接解析失败');
                const tweetId = match[1];

                const vxRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${tweetId}`);
                if (!vxRes.ok) throw new Error('抓取失败');
                const tweetData = await vxRes.json();

                let originalText = (tweetData.text || '').replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim();
                if (!originalText) originalText = "[仅图片/视频]";

                let rawUrls = [];
                let b64s = [];

                // 核心更新：强制提取原图画质
                for (const media of (tweetData.media_extended || [])) {
                    let highResUrl = media.url;
                    
                    // 自动判断并强制请求高清原图
                    if (media.type === 'image' && highResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)) {
                        const extMatch = highResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i);
                        const ext = extMatch[2];
                        highResUrl = highResUrl.replace(/\.[a-z]+(\?.*)?$/i, '') + `?format=${ext}&name=orig`;
                    } else if (media.type === 'video') {
                        highResUrl = media.url; // 视频直接使用 VX 提供的最高画质流
                    }

                    rawUrls.push({ type: media.type, url: highResUrl, thumbnail: media.thumbnail_url || highResUrl });
                    
                    if (options.needScreenshot) {
                        const b64 = await fetchImageAsBase64(media.thumbnail_url || highResUrl);
                        if (b64) b64s.push(b64);
                    }
                }

                let translatedResult = '';
                if (options.needTranslation && model) {
                    const prompt = `请将以下内容先翻译为英文，再翻译为中文：\n"${originalText}"\n要求：保留表情符号，删除话题标签，不要任何解释。`;
                    const result = await model.generateContent(prompt);
                    translatedResult = result.response.text().trim();
                }

                return {
                    originalText,
                    translation: translatedResult,
                    authorName: tweetData.user_name,
                    authorHandle: `@${tweetData.user_screen_name}`,
                    imagesBase64: b64s,
                    rawMediaUrls: rawUrls,
                    timestamp: tweetData.date_epoch * 1000
                };
            } catch (e) {
                return { error: e.message };
            }
        };

        const results = await Promise.all(urls.map(processSingleUrl));

        res.status(200).json({
            success: true,
            prefix,
            suffix,
            tweets: results
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
