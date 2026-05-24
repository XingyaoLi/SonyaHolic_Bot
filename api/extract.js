const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Vercel Serverless Function Edge Timeout Extension Config
export const config = {
    maxDuration: 60,
};

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

    const { urls, options } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: '未识别到有效的链接' });
    }

    const platform = options.platform || 'X';

    try {
        const prefix = process.env.BOT_TEXT_PREFIX || "";
        const suffix = process.env.BOT_TEXT_SUFFIX || "";
        
        let model = null;
        if (options.needTranslation) {
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
            if (!GEMINI_API_KEY) throw new Error("云端尚未配置 GEMINI_API_KEY");
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const safetySettings = [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
            ];
            model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite", safetySettings });
        }

        const xBaseRule = `
规则：
1. 非中英文语言先翻译成英文，再翻译成中文。英文直接翻译成中文，中文保留原文。翻译所有的有效正文内容。
2. 专属语境：推文很可能和泰国演员 Sonya Saranphat / LMSY 相关。如果内容里有“熊”相关名词（如 bear、หมี 或直接出现熊的代称）并且看起来像个人名，请必须替换成”Lookmhee“。
3. 去除标签：**请忽略并删除推文原文中的所有带 # 号的话题标签（Hashtags）**，不要保留。
4. 去除趋势关键词：**请智能识别并删除类似于 X 趋势打榜的关键词（特征通常为：全大写英文字母组成的短句、单独占一行、经常出现在标签附近，例如 "SONYA BORN TO BE A STAR"）。不要翻译也不要保留这些趋势词。**
5. 保留表情：请务必在译文中严格保留推文原文里的所有表情符号（emoji），按照它们在原文中的顺序展示。
6. 最终输出只需保留翻译后的中文正文以及原有的表情符号。绝不要输出任何解释说明。
7. 必须强行按照要求的排版格式输出。`;

        const igBaseRule = `
规则：
1. 非中英文语言先翻译成英文，再翻译成中文。英文直接翻译成中文，中文保留原文。翻译所有的有效正文内容。
2. 专属语境：内容很可能和泰国演员 Sonya Saranphat / LMSY 相关。如果内容里有“熊”相关名词（如 bear、หมี 或直接出现熊的代称）并且看起来像个人名，请必须替换成”Lookmhee“。
3. 去除标签：**请忽略并删除原文中的所有带 # 号的话题标签（Hashtags）**，不要保留。
4. 去除趋势关键词：**请智能识别并删除类似于趋势打榜的关键词。不要翻译也不要保留这些趋势词。**
5. 保留表情：请务必在译文中严格保留原文里的所有表情符号（emoji），按照它们在原文中的顺序展示。
6. 最终输出原文+空一行+翻译后的中文以及原有的表情符号。不要输出任何解释说明。
7. 必须强行按照要求的排版格式输出。`;

        // 处理单个链接的核心异步函数
        const processSingleUrl = async (link) => {
            let authorName = "";
            let authorHandle = "";
            let avatarUrl = "";
            let originalText = "";
            let timestamp = Date.now();
            let viewsCount = 0;
            let b64s = [];
            let rawUrls = [];
            let quoteInfo = null;
            let isReply = false;
            let parentInfo = null;
            let isPost = false;
            let isStory = false;

            if (platform === 'X') {
                const match = link.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/);
                if (!match) throw new Error('X 链接解析失败');
                const tweetId = match[1];

                const vxRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${tweetId}`);
                if (!vxRes.ok) throw new Error('抓取失败');
                const tweetData = await vxRes.json();

                authorName = tweetData.user_name;
                authorHandle = `@${tweetData.user_screen_name}`;
                avatarUrl = tweetData.user_profile_image_url;
                originalText = tweetData.text || '';
                timestamp = tweetData.date_epoch * 1000;
                viewsCount = tweetData.views || tweetData.likes || 0; 

                if (tweetData.in_reply_to_status_id_str || (tweetData.conversationID && tweetData.conversationID !== tweetId)) {
                    originalText = originalText.replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim();
                }
                
                for (const media of (tweetData.media_extended || [])) {
                    rawUrls.push({ type: media.type, url: media.url, thumbnail: media.thumbnail_url });
                    if (options.needScreenshot || options.needTranslation) {
                        const previewUrl = media.type === 'image' ? media.url : media.thumbnail_url;
                        const b64 = await fetchImageAsBase64(previewUrl);
                        if (b64) b64s.push(b64);
                    }
                }
                
                const parentId = (tweetData.conversationID && tweetData.conversationID !== tweetId) ? tweetData.conversationID : null;
                if (parentId) {
                    try {
                        const parentRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${parentId}`);
                        if (parentRes.ok) {
                            const pData = await parentRes.json();
                            isReply = true;
                            let pText = (pData.text || '').replace(/^(@[a-zA-Z0-9_]+\s*)+/g, '').trim();
                            if (!pText) pText = "[仅图片/视频，无文字]";
                            
                            let pB64s = [];
                            let pRaws = [];
                            for (const media of (pData.media_extended || [])) {
                                pRaws.push({ type: media.type, url: media.url, thumbnail: media.thumbnail_url });
                                if (options.needScreenshot) {
                                    const previewUrl = media.type === 'image' ? media.url : media.thumbnail_url;
                                    const b64 = await fetchImageAsBase64(previewUrl);
                                    if (b64) pB64s.push(b64);
                                }
                            }
                            parentInfo = {
                                name: pData.user_name,
                                handle: `@${pData.user_screen_name}`,
                                avatarBase64: options.needScreenshot ? await fetchImageAsBase64(pData.user_profile_image_url) : null,
                                text: pText,
                                imagesBase64: pB64s,
                                rawMediaUrls: pRaws
                            };
                        }
                    } catch (e) {}
                }

                if (!isReply && tweetData.qrtURL) {
                    try {
                        const qrtId = tweetData.qrtURL.split('/').pop();
                        const qrtRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${qrtId}`);
                        if (qrtRes.ok) {
                            const qrtData = await qrtRes.json();
                            let qText = qrtData.text || '[仅图片/视频，无文字]';
                            let qB64s = [];
                            let qRaws = [];
                            for (const media of (qrtData.media_extended || [])) {
                                qRaws.push({ type: media.type, url: media.url, thumbnail: media.thumbnail_url });
                                if (options.needScreenshot) {
                                    const previewUrl = media.type === 'image' ? media.url : media.thumbnail_url;
                                    const b64 = await fetchImageAsBase64(previewUrl);
                                    if (b64) qB64s.push(b64);
                                }
                            }
                            quoteInfo = {
                                name: qrtData.user_name,
                                handle: `@${qrtData.user_screen_name}`,
                                avatar: options.needScreenshot ? await fetchImageAsBase64(qrtData.user_profile_image_url) : null,
                                text: qText,
                                imagesBase64: qB64s,
                                rawMediaUrls: qRaws
                            };
                        }
                    } catch (e) {}
                }

                if (!originalText || originalText.trim() === '') originalText = "[仅图片/视频，无文字]";

            } else if (platform === 'IG') {
                // IG 模式专属提取引擎 (通过免登录代理获取元数据)
                isStory = link.includes('/stories/');
                isPost = link.includes('/p/') || link.includes('/reel/');

                const ddUrl = link.replace(/(https?:\/\/)?(www\.)?instagram\.com/, 'https://ddinstagram.com');
                const res = await fetch(ddUrl);
                const html = await res.text();

                // 提取作者
                const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
                if (titleMatch) {
                    const handleMatch = titleMatch[1].match(/@([a-zA-Z0-9_.]+)/);
                    if (handleMatch) authorHandle = `@${handleMatch[1]}`;
                    else authorHandle = `@${titleMatch[1].split(' ')[0]}`;
                    authorName = authorHandle.replace('@', '');
                } else {
                    const urlHandleMatch = link.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
                    if (urlHandleMatch && !['p','reel','stories'].includes(urlHandleMatch[1])) {
                        authorHandle = `@${urlHandleMatch[1]}`;
                    } else if (isStory) {
                        const storyMatch = link.match(/stories\/([a-zA-Z0-9_.]+)/);
                        if (storyMatch) authorHandle = `@${storyMatch[1]}`;
                    }
                    authorName = authorHandle.replace('@', '');
                }

                // 提取文案
                const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
                if (descMatch) {
                    originalText = descMatch[1].replace(/\\n/g, '\n').trim();
                    if (originalText.includes('likes,') && originalText.includes('comments')) {
                        originalText = originalText.split('-').slice(1).join('-').trim(); // 清洗掉前缀的点赞数据
                    }
                }

                // 提取媒体
                const videoMatch = html.match(/<meta property="og:video" content="([^"]+)"/);
                const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
                
                if (videoMatch) {
                    rawUrls.push({ type: 'video', url: videoMatch[1], thumbnail: imageMatch ? imageMatch[1] : '' });
                    if (options.needTranslation && imageMatch) {
                        const b64 = await fetchImageAsBase64(imageMatch[1]);
                        if (b64) b64s.push(b64);
                    }
                } else if (imageMatch) {
                    rawUrls.push({ type: 'image', url: imageMatch[1], thumbnail: imageMatch[1] });
                    if (options.needTranslation) {
                        const b64 = await fetchImageAsBase64(imageMatch[1]);
                        if (b64) b64s.push(b64);
                    }
                }
            }

            const avatarBase64 = (platform === 'X' && options.needScreenshot) ? await fetchImageAsBase64(avatarUrl) : null;
            let translatedResult = '';

            if (options.needTranslation && model) {
                let prompt = "";
                let parts = [];

                if (platform === 'X') {
                    if (isReply) {
                        prompt = `请翻译这段对话：${xBaseRule}\n要求排版：\n💬：[原贴译文]\n\n🐰：[回复译文]\n原贴内容：\n"${parentInfo?.text || ''}"\n回复内容：\n"${originalText}"`;
                    } else if (quoteInfo) {
                        prompt = `请翻译这段推文：${xBaseRule}\n要求排版：主推文译文在前，空一行，引用部分加前缀“转发内容：”。\n主推文：\n"${originalText}"\n引用推文：\n"${quoteInfo.text}"`;
                    } else {
                        prompt = `请翻译这段推文：${xBaseRule}\n推文：\n"${originalText}"`;
                    }
                    parts = [{ text: prompt }];
                } else {
                    // IG 模式：针对快拍且无文字的情况启用 OCR
                    if (isStory && (!originalText || originalText.trim() === '') && b64s.length > 0) {
                        prompt = `这是一张Instagram快拍的截图/封面。请提取图片中出现的文字并进行翻译。\n如果图片中没有任何有效文字，请直接回复“[图片无文字]”。\n\n${igBaseRule}`;
                        parts = [
                            { text: prompt },
                            { inlineData: { data: b64s[0].split(',')[1], mimeType: "image/jpeg" } }
                        ];
                    } else {
                        prompt = `请翻译这段Instagram内容：${igBaseRule}\n原文：\n"${originalText || '[无文字]'}"`;
                        parts = [{ text: prompt }];
                    }
                }
                
                let retries = 2;
                while (retries > 0) {
                    try {
                        const result = await model.generateContent(parts);
                        translatedResult = result.response.text().trim();
                        break;
                    } catch (e) {
                        retries--;
                        if (retries === 0) {
                            translatedResult = `（AI 翻译失败: ${e.message}）`;
                        } else await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }

            return {
                originalText, 
                translation: translatedResult,
                authorName,
                authorHandle,
                avatarBase64,
                imagesBase64: b64s,
                rawMediaUrls: rawUrls,
                quoteInfo,
                isReply,
                parentInfo,
                timestamp,
                viewsCount,
                isPost,
                isStory
            };
        };

        const results = await Promise.all(urls.slice(0, 8).map(processSingleUrl));

        res.status(200).json({
            success: true,
            prefix: options.needPrefix ? prefix : "",
            suffix: options.needSuffix ? suffix : "",
            tweets: results,
            platform
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: error.message || '内部错误' });
    }
}
