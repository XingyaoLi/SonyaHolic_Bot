const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

export const config = {
    maxDuration: 60,
};

// 带有超时控制的 fetch 函数，防止单次请求卡死整个进程
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

async function fetchImageAsBase64(url) {
    if (!url) return null;
    try {
        const response = await fetchWithTimeout(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' }
        }, 15000);
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
        return res.status(401).json({ error: '通行码错误' });
    }

    const { urls, options } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: '参数错误' });

    try {
        const prefix = process.env.BOT_TEXT_PREFIX || "";
        const suffix = process.env.BOT_TEXT_SUFFIX || "";

        const processSingleUrl = async (link) => {
            let retries = 2;
            while (retries > 0) {
                try {
                    const match = link.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/);
                    if (!match) throw new Error('链接解析失败');
                    const tweetId = match[1];

                    // 给主接口加上 15s 的超时，防止偶尔的不响应
                    const vxRes = await fetchWithTimeout(`https://api.vxtwitter.com/Twitter/status/${tweetId}`, {}, 15000);
                    if (!vxRes.ok) throw new Error('API 响应异常');
                    const tweetData = await vxRes.json();

                    let originalText = (tweetData.text || '').replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim() || "[仅图片/视频]";
                    
                    // --- 封装提取高清原图和 Base64 的并发逻辑 ---
                    const extractMediaParams = async (mediaArray) => {
                        let rawUrls = [];
                        let b64s = [];
                        const mediaPromises = (mediaArray || []).map(async (media) => {
                            let highResUrl = media.url;
                            let thumbnailUrl = media.thumbnail_url || media.url;

                            // 强行挂上 orig 参数获取 X 的极限原图画质
                            if (media.type === 'image' && highResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)) {
                                const ext = highResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)[2];
                                highResUrl = highResUrl.replace(/\.[a-z]+(\?.*)?$/i, '') + `?format=${ext}&name=orig`;
                                thumbnailUrl = highResUrl;
                            } else if (media.type === 'video' && thumbnailUrl.match(/twimg\.com\/.*\.([a-z]+)/i)) {
                                const ext = thumbnailUrl.match(/twimg\.com\/.*\.([a-z]+)/i)[1];
                                if (ext === 'jpg' || ext === 'png') {
                                    thumbnailUrl = thumbnailUrl.replace(/\.[a-z]+(\?.*)?$/i, '') + `?format=${ext}&name=orig`;
                                }
                            }

                            let b64 = null;
                            if (options.needScreenshot) {
                                const previewUrl = media.type === 'image' ? highResUrl : thumbnailUrl;
                                b64 = await fetchImageAsBase64(previewUrl);
                            }
                            return { rawUrl: { type: media.type, url: highResUrl, thumbnail: thumbnailUrl }, b64: b64 };
                        });

                        const mediaResults = await Promise.all(mediaPromises);
                        for (const res of mediaResults) {
                            rawUrls.push(res.rawUrl);
                            if (res.b64) b64s.push(res.b64);
                        }
                        return { rawUrls, b64s };
                    };

                    // 1. 提取当前主推文的多媒体
                    const mainMedia = await extractMediaParams(tweetData.media_extended);
                    
                    // 2. 检查是否为回复（Reply）并抓取原贴
                    let isReply = false;
                    let parentInfo = null;
                    const parentId = (tweetData.conversationID && tweetData.conversationID !== tweetId) ? tweetData.conversationID : null;

                    if (parentId) {
                        try {
                            const parentRes = await fetchWithTimeout(`https://api.vxtwitter.com/Twitter/status/${parentId}`, {}, 10000);
                            if (parentRes.ok) {
                                const pData = await parentRes.json();
                                isReply = true;
                                let pText = (pData.text || '').replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim() || "[仅图片/视频]";
                                const pMedia = await extractMediaParams(pData.media_extended);
                                
                                parentInfo = {
                                    name: pData.user_name,
                                    handle: `@${pData.user_screen_name}`,
                                    avatarBase64: options.needScreenshot ? await fetchImageAsBase64(pData.user_profile_image_url) : null,
                                    text: pText,
                                    imagesBase64: pMedia.b64s,
                                    rawMediaUrls: pMedia.rawUrls
                                };
                            }
                        } catch (e) {}
                    }

                    // 3. 检查是否为引用转发（Quote）并抓取被引用的原贴
                    let quoteInfo = null;
                    if (!isReply && tweetData.qrtURL) {
                        try {
                            const qrtId = tweetData.qrtURL.split('/').pop();
                            const qrtRes = await fetchWithTimeout(`https://api.vxtwitter.com/Twitter/status/${qrtId}`, {}, 10000);
                            if (qrtRes.ok) {
                                const qrtData = await qrtRes.json();
                                let qText = (qrtData.text || '').replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim() || "[仅图片/视频]";
                                const qMedia = await extractMediaParams(qrtData.media_extended);

                                quoteInfo = {
                                    name: qrtData.user_name,
                                    handle: `@${qrtData.user_screen_name}`,
                                    avatar: options.needScreenshot ? await fetchImageAsBase64(qrtData.user_profile_image_url) : null,
                                    text: qText,
                                    imagesBase64: qMedia.b64s,
                                    rawMediaUrls: qMedia.rawUrls
                                };
                            }
                        } catch (e) {}
                    }

                    // 4. 提取主作者的头像
                    const avatarBase64 = options.needScreenshot ? await fetchImageAsBase64(tweetData.user_profile_image_url) : null;

                    // 5. 组装翻译 Prompt 并调用 AI
                    let translatedResult = '';
                    if (options.needTranslation && process.env.GEMINI_API_KEY) {
                        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                        const safetySettings = [
                            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                        ];
                        
                        const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite", safetySettings });
                        
                        const xBaseRule = `规则：
1. 非中英文语言先翻译成英文，再翻译成中文。英文直接翻译成中文，中文保留原文。翻译所有的有效正文内容。
2. 专属语境：推文很可能和泰国演员 Sonya Saranphat / LMSY 相关。如果内容里有“熊”相关名词（如 bear、หมี 或直接出现熊的代称）并且看起来像个人名，请必须替换成”Lookmhee“。
3. 去除标签：**请忽略并删除推文原文中的所有带 # 号的话题标签（Hashtags）**，不要保留。
4. 去除趋势关键词：**请智能识别并删除类似于 X 趋势打榜的关键词（特征通常为：全大写英文字母组成的短句、单独占一行、经常出现在标签附近，例如 "SONYA BORN TO BE A STAR"）。不要翻译也不要保留这些趋势词。**
5. 保留表情：请务必在译文中严格保留推文原文里的所有表情符号（emoji），按照它们在原文中的顺序展示。
6. 最终输出只需保留翻译后的中文正文以及原有的表情符号。绝不要输出任何解释说明。
7. 必须强行按照要求的排版格式输出。`;

                        let prompt = "";
                        if (isReply && parentInfo) {
                            prompt = `请翻译这段对话：${xBaseRule}\n要求排版：\n💬：[原贴译文]\n\n🐰：[回复译文]\n原贴内容：\n"${parentInfo.text}"\n回复内容：\n"${originalText}"`;
                        } else if (quoteInfo) {
                            prompt = `请翻译这段推文：${xBaseRule}\n要求排版：主推文译文在前，空一行，引用部分加前缀“转发内容：”。\n主推文：\n"${originalText}"\n引用推文：\n"${quoteInfo.text}"`;
                        } else {
                            prompt = `请翻译这段推文：${xBaseRule}\n推文：\n"${originalText}"`;
                        }

                        const result = await model.generateContent(prompt);
                        translatedResult = result.response.text().trim();
                    }

                    // 6. 返回前端所需的所有字段
                    return { 
                        originalText, 
                        translation: translatedResult, 
                        authorName: tweetData.user_name, 
                        authorHandle: `@${tweetData.user_screen_name}`, 
                        avatarBase64: avatarBase64,
                        imagesBase64: mainMedia.b64s, 
                        rawMediaUrls: mainMedia.rawUrls,
                        quoteInfo: quoteInfo,
                        isReply: isReply,
                        parentInfo: parentInfo,
                        timestamp: tweetData.date_epoch * 1000,
                        viewsCount: tweetData.views || tweetData.likes || 0
                    };
                } catch (e) {
                    retries--;
                    if (retries === 0) {
                        return { 
                            originalText: '抓取失败', 
                            translation: `❌ 提取此链接失败：${e.message}`, 
                            authorName: 'Unknown', 
                            authorHandle: '@unknown', 
                            avatarBase64: null,
                            imagesBase64: [], 
                            rawMediaUrls: [], 
                            quoteInfo: null,
                            isReply: false,
                            parentInfo: null,
                            timestamp: Date.now(),
                            viewsCount: 0
                        };
                    }
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        };

        const results = await Promise.all(urls.map(processSingleUrl));
        res.status(200).json({ success: true, prefix, suffix, tweets: results });
    } catch (error) {
        res.status(500).json({ error: '服务处理异常' });
    }
}
