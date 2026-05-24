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
    } catch (e) {
        return null;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const link = req.body.url;
    if (!link || (!link.includes('x.com') && !link.includes('twitter.com'))) {
        return res.status(400).json({ error: '无效的 X (Twitter) 链接' });
    }

    try {
        const match = link.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/);
        if (!match) return res.status(400).json({ error: '无法解析推文 ID' });
        const tweetId = match[1];

        // 调用开源免登录接口抓取数据
        const vxRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${tweetId}`);
        if (!vxRes.ok) return res.status(404).json({ error: '抓取失败，推文可能已删除或账号为私密' });
        const tweetData = await vxRes.json();

        // 解析推文数据
        const authorName = tweetData.user_name;
        const authorHandle = `@${tweetData.user_screen_name}`;
        const avatarUrl = tweetData.user_profile_image_url;
        let originalText = tweetData.text || '';
        const timestamp = tweetData.date_epoch * 1000;
        
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

        let parentText = '';
        let quoteInfo = null;
        if (tweetData.qrtURL) {
            try {
                const qrtId = tweetData.qrtURL.split('/').pop();
                const qrtRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${qrtId}`);
                if (qrtRes.ok) {
                    const qrtData = await qrtRes.json();
                    parentText = qrtData.text || '';
                    originalText += `\n\n[引用的推文]:\n${parentText}`;
                    quoteInfo = {
                        name: qrtData.user_name,
                        handle: `@${qrtData.user_screen_name}`,
                        avatar: await fetchImageAsBase64(qrtData.user_profile_image_url),
                        text: parentText
                    };
                }
            } catch (e) {}
        }

        const avatarBase64 = await fetchImageAsBase64(avatarUrl);

        // 调用 Gemini 进行专业翻译
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
        if (!GEMINI_API_KEY) return res.status(500).json({ error: '云端未配置 Gemini API Key' });

        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        
        // 【关键修复 1】：解除安全审查限制，防止推特上的俚语或特定词汇被误伤拦截
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", safetySettings });
        
        const baseRule = `
规则：
1. 请先在内部翻译成英文，然后再翻译成中文。务必翻译【所有】的有效正文内容。
2. 专属语境：推文很可能和泰国演员 Sonya Saranphat / LMSY 相关。如果内容里有“熊”相关名词（如 bear、หมี 或直接出现熊的代称）并且看起来像个人名，请必须替换成”Lookmhee“。
3. 去除标签：**请忽略并删除推文原文中的所有带 # 号的话题标签（Hashtags）**，不要保留。
4. 去除趋势关键词：**请智能识别并删除类似于 X 趋势打榜的关键词（特征通常为：全大写英文字母组成的短句、单独占一行、经常出现在标签附近，例如 "SONYA BORN TO BE A STAR"）。不要翻译也不要保留这些趋势词。**
5. 保留表情：请务必在译文中严格保留推文原文里的所有表情符号（emoji），按照它们在原文中的顺序展示。
6. 如果原文包含 [引用的推文] 的标记，请在翻译时使用“转发内容：”作为排版格式前缀，将引用的内容翻译在后面。
7. 最终输出只需保留翻译后的中文正文以及原有的表情符号。绝不要输出任何解释说明。`;

        const prompt = `你是一个专业的翻译官。请按以下规则翻译这段推文：${baseRule}\n推文原文：\n"${originalText}"`;
        
        let translatedResult = '';
        let retries = 3; // 设置最大重试次数为 3 次

        // 【关键修复 2】：加入自动重试机制
        while (retries > 0) {
            try {
                const result = await model.generateContent(prompt);
                translatedResult = result.response.text().trim();
                break; // 翻译成功，跳出循环
            } catch (e) {
                retries--;
                if (retries === 0) {
                    translatedResult = "（AI 翻译暂时失败，可能触及API限制，请稍后再试）";
                    console.error("AI 翻译彻底失败:", e);
                } else {
                    // 如果失败，强制等待 1.5 秒后再次尝试
                    console.log(`翻译失败，正在重试... 剩余次数: ${retries}`);
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }
        }

        // 组装 GMT+8 时区的日期和排版文案
        const gmt8Date = new Date(new Date().getTime() + (8 * 60 * 60 * 1000));
        const dateStr = `${gmt8Date.getUTCFullYear()}${String(gmt8Date.getUTCMonth() + 1).padStart(2, '0')}${String(gmt8Date.getUTCDate()).padStart(2, '0')}`;
        
        const finalText = `${dateStr} X更新Sonya相关\n\n${translatedResult}\n\ncr：${authorName}`;

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
                timestamp
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: '服务器内部错误，抓取失败' });
    }
}
