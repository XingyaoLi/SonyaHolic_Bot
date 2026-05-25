const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Vercel Serverless Function Edge Timeout Extension Config
export const config = {
    maxDuration: 60,
};

// 带双重防封机制的图片转码器（专为 OCR 准备）
async function fetchImageAsBase64(url) {
    if (!url) return null;
    try {
        let response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
            }
        });
        
        // 如果 IG 的 CDN 拒绝了直接访问，启用 allorigins 跨域穿透提取
        if (!response.ok) {
            response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
        }
        
        if (!response.ok) return null;
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
            try {
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
                    
                    // 核心黑科技：提取 Twitter 终极无损原图 (orig)
                    for (const media of (tweetData.media_extended || [])) {
                        let highResUrl = media.url;
                        let thumbnailUrl = media.thumbnail_url || media.url;

                        if (media.type === 'image' && highResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)) {
                            const extMatch = highResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i);
                            const ext = extMatch[2];
                            highResUrl = highResUrl.replace(/\.[a-z]+(\?.*)?$/i, '') + `?format=${ext}&name=orig`;
                            thumbnailUrl = highResUrl;
                        }

                        rawUrls.push({ type: media.type, url: highResUrl, thumbnail: thumbnailUrl });
                        if (options.needScreenshot || options.needTranslation) {
                            const previewUrl = media.type === 'image' ? highResUrl : thumbnailUrl;
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
                                    let pHighResUrl = media.url;
                                    let pThumbUrl = media.thumbnail_url || media.url;

                                    if (media.type === 'image' && pHighResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)) {
                                        const ext = pHighResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)[2];
                                        pHighResUrl = pHighResUrl.replace(/\.[a-z]+(\?.*)?$/i, '') + `?format=${ext}&name=orig`;
                                        pThumbUrl = pHighResUrl;
                                    }

                                    pRaws.push({ type: media.type, url: pHighResUrl, thumbnail: pThumbUrl });
                                    if (options.needScreenshot) {
                                        const b64 = await fetchImageAsBase64(media.type === 'image' ? pHighResUrl : pThumbUrl);
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
                                    let qHighResUrl = media.url;
                                    let qThumbUrl = media.thumbnail_url || media.url;

                                    if (media.type === 'image' && qHighResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)) {
                                        const ext = qHighResUrl.match(/twimg\.com\/media\/([^.]+)\.([a-z]+)/i)[2];
                                        qHighResUrl = qHighResUrl.replace(/\.[a-z]+(\?.*)?$/i, '') + `?format=${ext}&name=orig`;
                                        qThumbUrl = qHighResUrl;
                                    }

                                    qRaws.push({ type: media.type, url: qHighResUrl, thumbnail: qThumbUrl });
                                    if (options.needScreenshot) {
                                        const b64 = await fetchImageAsBase64(media.type === 'image' ? qHighResUrl : qThumbUrl);
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
                    // Instagram 极限破壁解析模块
                    isStory = link.includes('/stories/');
                    isPost = link.includes('/p/') || link.includes('/reel/') || link.includes('/tv/');
                    let lastErrorMsg = "";

                    authorHandle = "@unknown";
                    authorName = "IG User";

                    // 1. 提取全尺寸多媒体 (调用最新的 Cobalt 官方 API)
                    try {
                        const coRes = await fetch("https://api.cobalt.tools/api/json", {
                            method: "POST",
                            headers: {
                                "Accept": "application/json",
                                "Content-Type": "application/json",
                                "Origin": "https://cobalt.tools",
                                "Referer": "https://cobalt.tools/",
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                            },
                            body: JSON.stringify({ url: link })
                        });
                        
                        if (coRes.ok) {
                            const coData = await coRes.json();
                            if (coData.status !== "error") {
                                if (coData.picker) {
                                    coData.picker.forEach(p => rawUrls.push({ 
                                        type: p.type === 'video' ? 'video' : 'image', 
                                        url: p.url, 
                                        thumbnail: p.thumb || p.url 
                                    }));
                                } else if (coData.url) {
                                    rawUrls.push({ 
                                        type: (link.includes('reel') || coData.url.includes('.mp4')) ? 'video' : 'image', 
                                        url: coData.url, 
                                        thumbnail: coData.url 
                                    });
                                }
                            }
                        }
                    } catch(e) { lastErrorMsg += `[提取媒体错误: ${e.message}]`; }

                    // 2. 提取配文和作者 (解析 IG 免登录的 Embed 页面核心 JSON 数据)
                    if (isPost) {
                        try {
                            const shortcodeMatch = link.match(/(?:p|reel|tv)\/([^/?#&]+)/);
                            if (shortcodeMatch) {
                                const embedUrl = `https://www.instagram.com/p/${shortcodeMatch[1]}/embed/captioned/`;
                                const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(embedUrl)}`;
                                const embedRes = await fetch(proxyUrl);
                                
                                if (embedRes.ok) {
                                    const embedData = await embedRes.json();
                                    const html = embedData.contents;
                                    
                                    // 查找 IG 官方在网页中下发的原生 JSON 包
                                    const jsonMatch = html.match(/window\.__additionalDataLoaded\('extra',\s*({.+?})\);/);
                                    if (jsonMatch) {
                                        const igData = JSON.parse(jsonMatch[1]).shortcode_media;
                                        
                                        if (igData.owner) {
                                            authorHandle = `@${igData.owner.username}`;
                                            authorName = igData.owner.full_name || igData.owner.username;
                                        }
                                        
                                        if (igData.edge_media_to_caption?.edges?.length > 0) {
                                            originalText = igData.edge_media_to_caption.edges[0].node.text;
                                        }
                                        
                                        // 如果前面的 Cobalt 获取媒体失败，启用 Embed 数据作为保底抓图
                                        if (rawUrls.length === 0) {
                                            if (igData.edge_sidecar_to_children) {
                                                igData.edge_sidecar_to_children.edges.forEach(edge => {
                                                    const node = edge.node;
                                                    rawUrls.push({
                                                        type: node.is_video ? 'video' : 'image',
                                                        url: node.video_url || node.display_url,
                                                        thumbnail: node.display_url
                                                    });
                                                });
                                            } else {
                                                rawUrls.push({
                                                    type: igData.is_video ? 'video' : 'image',
                                                    url: igData.video_url || igData.display_url,
                                                    thumbnail: igData.display_url
                                                });
                                            }
                                        }
                                    } else {
                                        // 备用正则匹配
                                        const authorMatch = html.match(/"owner_username":"([^"]+)"/);
                                        if (authorMatch) authorHandle = `@${authorMatch[1]}`;
                                        const captionMatch = html.match(/"caption":"([^"]+)"/);
                                        if (captionMatch) originalText = captionMatch[1].replace(/\\n/g, '\n').replace(/\\/g, '');
                                    }
                                }
                            }
                        } catch(e) { lastErrorMsg += `[提取配文错误: ${e.message}]`; }
                    }

                    if (rawUrls.length === 0 && !originalText) {
                        throw new Error(`IG防爬虫严格拦截或内容为私密。(${lastErrorMsg})`);
                    }

                    // 准备 OCR 缩略图
                    for (const item of rawUrls) {
                        if (options.needTranslation && b64s.length < 2) {
                            const b64 = await fetchImageAsBase64(item.thumbnail || item.url);
                            if (b64) b64s.push(b64);
                        }
                    }
                }

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

            } catch (error) {
                console.error("Url processing error:", error.message);
                return {
                    originalText: `【抓取失败】${error.message}`,
                    translation: `❌ 提取此链接失败：${error.message}。`,
                    authorName: "Unknown",
                    authorHandle: "@unknown",
                    avatarBase64: null,
                    imagesBase64: [],
                    rawMediaUrls: [],
                    quoteInfo: null,
                    isReply: false,
                    parentInfo: null,
                    timestamp: Date.now(),
                    viewsCount: 0,
                    isPost: platform === 'IG',
                    isStory: false
                };
            }
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
