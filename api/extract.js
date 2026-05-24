const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// 将图片 URL 转换为 Base64
async function fetchImageAsBase64(url) {
    if (!url) return null;
    try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const mimeType = response.headers.get('content-type') || 'image/jpeg';
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (e) { return null; }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // 【1. 密码验证门禁】
    const clientPwd = req.headers['x-bot-password'];
    const serverPwd = process.env.BOT_PASSWORD; // 你需要在 Vercel 环境变量里加一个 BOT_PASSWORD
    if (serverPwd && clientPwd !== serverPwd) {
        return res.status(401).json({ error: '密码错误或登录失效' });
    }

    const link = req.body.url;
    if (!link || (!link.includes('x.com') && !link.includes('twitter.com'))) {
        return res.status(400).json({ error: '无效的 X 链接' });
    }

    try {
        const match = link.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/);
        if (!match) return res.status(400).json({ error: '无法解析推文 ID' });
        const tweetId = match[1];

        const vxRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${tweetId}`);
        if (!vxRes.ok) return res.status(404).json({ error: '抓取失败' });
        const tweetData = await vxRes.json();

        const authorName = tweetData.user_name;
        const authorHandle = `@${tweetData.user_screen_name}`;
        const avatarUrl = tweetData.user_profile_image_url;
        let originalText = tweetData.text || '';
        const timestamp = tweetData.date_epoch * 1000;
        const viewsCount = tweetData.views || tweetData.likes || 0; 
        
        const mediaFiles = tweetData.media_extended || [];
        const imagesBase64 = [];
        const rawMediaUrls = [];

        for (const media of mediaFiles) {
            rawMediaUrls.push({ type: media.type, url: media.url, thumbnail: media.thumbnail_url });
            if (media.type === 'image' || media.type === 'video') {
                const previewUrl = media.type === 'image' ? media.url : media.thumbnail_url;
                const b64 = await fetchImageAsBase64(previewUrl);
                if (b64) imagesBase64.push(b64);
            }
        }

        // 【2. 抓取原贴（如果是回复别人）】
        let isReply = false;
        let parentText = '';
        let parentInfo = null;
        // 尝试从 vxtwitter 数据中获取父推文 ID
        const parentId = tweetData.in_reply_to_status_id_str || (tweetData.replying_to ? tweetData.conversationID : null);

        if (parentId && parentId !== tweetId) {
            try {
                const parentRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${parentId}`);
                if (parentRes.ok) {
                    const pData = await parentRes.json();
                    isReply = true;
                    parentText = pData.text || '';
                    parentInfo = {
                        name: pData.user_name,
                        handle: `@${pData.user_screen_name}`,
                        avatarBase64: await fetchImageAsBase64(pData.user_profile_image_url),
                        text: parentText
                    };
                }
            } catch (e) {}
        }

        // 处理引用 (Quote)
        let quoteInfo = null;
        if (!isReply && tweetData.qrtURL) {
            try {
                const qrtId = tweetData.qrtURL.split('/').pop();
                const qrtRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${qrtId}`);
                if (qrtRes.ok) {
                    const qrtData = await qrtRes.json();
                    quoteInfo = {
                        name: qrtData.user_name,
                        handle: `@${qrtData.user_screen_name}`,
                        avatar: await fetchImageAsBase64(qrtData.user_profile_image_url),
                        text: qrtData.text || ''
                    };
                }
            } catch (e) {}
        }

        const avatarBase64 = await fetchImageAsBase64(avatarUrl);

        // 【3. AI 翻译核心】
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
        if (!GEMINI_API_KEY) return res.status(500).json({ error: '未配置 Gemini API Key' });

        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", safetySettings });
        
        const baseRule = `
规则：
1. 请先翻译成英文，然后再翻译成中文。
2. 语境：与泰国演员 Sonya Saranphat / LMSY 相关。名词“熊”(bear, หมี)等如果是代称请替换成”Lookmhee“。
3. 去除带 # 号的话题标签。
4. 去除全大写类似 "SONYA BORN TO BE A STAR" 的趋势打榜词。
5. 严格保留原文表情符号(emoji)。`;

        let prompt = "";
        if (isReply) {
            prompt = `请翻译这段对话：${baseRule}
要求排版（必须包含表情和空行）：\n💬：[原贴译文]\n\n🐰：[回复译文]
原贴内容：\n"${parentText}"\n回复内容：\n"${originalText}"`;
        } else if (quoteInfo) {
            prompt = `请翻译这段推文（包含引用的推文）：${baseRule}
要求排版：主推文译文在前，并在和引用译文之间空一行，引用部分加前缀“转发内容：”。
推文：\n"${originalText}"\n引用推文：\n"${quoteInfo.text}"`;
        } else {
            prompt = `请翻译这段推文：${baseRule}\n推文：\n"${originalText}"`;
        }
        
        let translatedResult = '';
        let retries = 3;
        while (retries > 0) {
            try {
                const result = await model.generateContent(prompt);
                translatedResult = result.response.text().trim();
                break;
            } catch (e) {
                retries--;
                if (retries === 0) translatedResult = "（AI 翻译失败，请稍后重试）";
                else await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        // 【4. 智能日期与文案组装】
        const tweetDate = new Date(timestamp);
        const gmt8Date = new Date(tweetDate.getTime() + (8 * 60 * 60 * 1000));
        const yyyy = gmt8Date.getUTCFullYear();
        const mm = String(gmt8Date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(gmt8Date.getUTCDate()).padStart(2, '0');
        const dateStr = `${yyyy}${mm}${dd}`; // 格式：20260524

        const isSonya = authorHandle.toLowerCase() === '@sonyasarann';
        let finalText = '';

        if (isSonya) {
            if (isReply) {
                finalText = `${dateStr} Sonya X 回复\n\n${translatedResult}`;
            } else {
                finalText = `${dateStr} Sonya X 更新\n\n${translatedResult}`;
            }
        } else {
            finalText = `${dateStr} X更新Sonya相关\n\n${translatedResult}\n\ncr：${authorName}`;
        }

        res.status(200).json({
            success: true,
            tweet: {
                originalText: tweetData.text,
                finalText: finalText,
                authorName,
                authorHandle,
                avatarBase64,
                imagesBase64,
                rawMediaUrls,
                quoteInfo,
                isReply,
                parentInfo,
                timestamp,
                viewsCount
            }
        });

    } catch (error) {
        res.status(500).json({ error: '内部错误' });
    }
}
