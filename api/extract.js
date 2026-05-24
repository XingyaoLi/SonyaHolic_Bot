const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

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

    const clientPwd = req.headers['x-bot-password'];
    const serverPwd = process.env.BOT_PASSWORD; 
    if (serverPwd && clientPwd !== serverPwd) {
        return res.status(401).json({ error: '通行码错误或登录失效' });
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
        if (!vxRes.ok) return res.status(404).json({ error: '抓取失败，请检查链接' });
        const tweetData = await vxRes.json();

        const authorName = tweetData.user_name;
        const authorHandle = `@${tweetData.user_screen_name}`;
        const avatarUrl = tweetData.user_profile_image_url;
        let originalText = tweetData.text || '';
        const timestamp = tweetData.date_epoch * 1000;
        const viewsCount = tweetData.views || tweetData.likes || 0; 

        // 【细节优化】如果是回复推文，彻底切除最前方的 @提及id 字符串
        if (tweetData.in_reply_to_status_id_str || (tweetData.conversationID && tweetData.conversationID !== tweetId)) {
            originalText = originalText.replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim();
        }
        
        const extractMediaParams = async (mediaArray) => {
            const b64s = [];
            const rawUrls = [];
            for (const media of mediaArray) {
                rawUrls.push({ type: media.type, url: media.url, thumbnail: media.thumbnail_url });
                if (media.type === 'image' || media.type === 'video') {
                    const previewUrl = media.type === 'image' ? media.url : media.thumbnail_url;
                    const b64 = await fetchImageAsBase64(previewUrl);
                    if (b64) b64s.push(b64);
                }
            }
            return { b64s, rawUrls };
        };

        const mainMedia = await extractMediaParams(tweetData.media_extended || []);
        const imagesBase64 = mainMedia.b64s;
        const rawMediaUrls = mainMedia.rawUrls;

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
                    // 同样清理父级推文可能带有的 @提及id
                    parentText = parentText.replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim();

                    const pMedia = await extractMediaParams(pData.media_extended || []);
                    
                    parentInfo = {
                        name: pData.user_name,
                        handle: `@${pData.user_screen_name}`,
                        avatarBase64: await fetchImageAsBase64(pData.user_profile_image_url),
                        text: parentText,
                        imagesBase64: pMedia.b64s,
                        rawMediaUrls: pMedia.rawUrls
                    };
                }
            } catch (e) {}
        }

        let quoteInfo = null;
        if (!isReply && tweetData.qrtURL) {
            try {
                const qrtId = tweetData.qrtURL.split('/').pop();
                const qrtRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${qrtId}`);
                if (qrtRes.ok) {
                    const qrtData = await qrtRes.json();
                    const qMedia = await extractMediaParams(qrtData.media_extended || []);

                    quoteInfo = {
                        name: qrtData.user_name,
                        handle: `@${qrtData.user_screen_name}`,
                        avatar: await fetchImageAsBase64(qrtData.user_profile_image_url),
                        text: qrtData.text || '',
                        imagesBase64: qMedia.b64s,
                        rawMediaUrls: qMedia.rawUrls
                    };
                }
            } catch (e) {}
        }

        const avatarBase64 = await fetchImageAsBase64(avatarUrl);

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
1. 翻译成中文。专属语境：泰国演员 Sonya Saranphat/LMSY。名词“熊”替换为”Lookmhee“。
2. 完全忽略并删除所有带 # 号的 Hashtags。
3. 智能识别并删除全大写趋势打榜短句。
4. 务必严格保留原文里的所有表情符号(emoji)。
5. 即使内容极短（例如只有一句话或几个表情），也必须强行按照要求的排版格式输出，绝不能报错。不要附加任何解释说明。`;

        let prompt = "";
        if (isReply) {
            prompt = `请翻译这段对话：${baseRule}
要求排版：\n💬：[原贴译文]\n\n🐰：[回复译文]
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

        const tweetDate = new Date(timestamp);
        const gmt8Date = new Date(tweetDate.getTime() + (8 * 60 * 60 * 1000));
        const yyyy = gmt8Date.getUTCFullYear();
        const mm = String(gmt8Date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(gmt8Date.getUTCDate()).padStart(2, '0');
        const dateStr = `${yyyy}${mm}${dd}`; 

        const isSonya = authorHandle.toLowerCase() === '@sonyasarann';
        let finalText = '';

        if (isSonya) {
            if (isReply) finalText = `${dateStr} Sonya X 回复\n\n${translatedResult}`;
            else finalText = `${dateStr} Sonya X 更新\n\n${translatedResult}`;
        } else {
            finalText = `${dateStr} X更新Sonya相关\n\n${translatedResult}\n\ncr：${authorName}`;
        }

        res.status(200).json({
            success: true,
            tweet: {
                originalText, // 已经洗掉了开头的 @提及
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
