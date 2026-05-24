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

    // 【密码门禁校验】
    const clientPwd = req.headers['x-bot-password'];
    const serverPwd = process.env.BOT_PASSWORD; 
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

        // 抓取目标推文数据
        const vxRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${tweetId}`);
        if (!vxRes.ok) return res.status(404).json({ error: '抓取失败，请检查链接' });
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

        // 【核心修复：彻底解决回复原贴无法抓取的问题】
        // 使用 conversationID（对话主轴）来逆向找到被回复的那条帖子
        let isReply = false;
        let parentText = '';
        let parentInfo = null;
        const parentId = (tweetData.conversationID && tweetData.conversationID !== tweetId) ? tweetData.conversationID : null;

        if (parentId) {
            try {
                const parentRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${parentId}`);
                if (parentRes.ok) {
                    const pData = await parentRes.json();
                    isReply = true;
                    parentText = pData.text || '';
                    
                    // 顺便把被回复帖子里的配图也抓下来，用于高仿截图排版
                    const pMediaFiles = pData.media_extended || [];
                    const pImagesBase64 = [];
                    for (const media of pMediaFiles) {
                        if (media.type === 'image' || media.type === 'video') {
                            const previewUrl = media.type === 'image' ? media.url : media.thumbnail_url;
                            const b64 = await fetchImageAsBase64(previewUrl);
                            if (b64) pImagesBase64.push(b64);
                        }
                    }

                    parentInfo = {
                        name: pData.user_name,
                        handle: `@${pData.user_screen_name}`,
                        avatarBase64: await fetchImageAsBase64(pData.user_profile_image_url),
                        text: parentText,
                        imagesBase64: pImagesBase64
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

        // 【AI 翻译引擎】
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
        if (!GEMINI_API_KEY) return res.status(500).json({ error: '未配置 Gemini API Key' });

        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        // 解除误伤封印
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", safetySettings });
        
        // 规则强化：即使是 Sonya 自己发的，也要统一格式化去除趋势词
        const baseRule = `
规则：
1. 请先翻译成英文，然后再翻译成中文。务必翻译所有句子。
2. 专属语境：推文可能和泰国演员 Sonya Saranphat 相关。如果有“熊”(bear, หมี)等代称，请替换为”Lookmhee“。
3. 去除标签：**完全忽略并删除所有带 # 号的 Hashtags**。
4. 去除趋势词：**智能识别并删除类似于 X 趋势打榜的全大写单独占行短句（如 SONYA BORN TO BE A STAR 等），绝对不要保留和翻译。**
5. 保留表情：**务必严格在原位保留原文里的所有表情符号(emoji)。**
6. 最终只输出排版好的纯中文和表情，绝对不要带解释。`;

        let prompt = "";
        if (isReply) {
            prompt = `请翻译这段对话：${baseRule}
要求排版（包含表情和空行）：\n💬：[原贴纯中文译文]\n\n🐰：[回复纯中文译文]
原贴内容：\n"${parentText}"\n回复内容：\n"${originalText}"`;
        } else if (quoteInfo) {
            prompt = `请翻译这段推文：${baseRule}
要求排版：主推文译文在前，空一行，引用部分加前缀“转发内容：”。
主推文：\n"${originalText}"\n引用推文：\n"${quoteInfo.text}"`;
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
                if (retries === 0) translatedResult = "（AI 翻译暂时失败，请重试）";
                else await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        // 【智能前缀与日期组装引擎】
        const tweetDate = new Date(timestamp);
        const gmt8Date = new Date(tweetDate.getTime() + (8 * 60 * 60 * 1000));
        const yyyy = gmt8Date.getUTCFullYear();
        const mm = String(gmt8Date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(gmt8Date.getUTCDate()).padStart(2, '0');
        const dateStr = `${yyyy}${mm}${dd}`; // 获取原贴在东八区的真实发布日期

        // 判断是否为 Sonya 本人 (不区分大小写匹配)
        const isSonya = authorHandle.toLowerCase() === '@sonyasarann';
        let finalText = '';

        if (isSonya) {
            if (isReply) {
                finalText = `${dateStr} Sonya X 回复\n\n${translatedResult}`;
            } else {
                finalText = `${dateStr} Sonya X 更新\n\n${translatedResult}`; // 不带 cr：
            }
        } else {
            // 不是 Sonya 发的，带上搬运 cr
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
