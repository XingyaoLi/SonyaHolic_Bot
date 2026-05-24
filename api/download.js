// 开启 Vercel 的 Edge (边缘节点) 模式，无视文件大小限制进行高速数据流转发
export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    // 获取前端传过来的原始视频链接
    const urlObj = new URL(req.url);
    const videoUrl = urlObj.searchParams.get('url');

    if (!videoUrl) {
        return new Response('缺少 url 参数', { status: 400 });
    }

    try {
        // 让云端服务器去抓取视频（突破跨域限制）
        const response = await fetch(videoUrl);
        if (!response.ok) {
            return new Response('无法获取视频源', { status: response.status });
        }

        // 复制原始数据流的头部
        const headers = new Headers(response.headers);
        
        // 【核心黑科技 1】：强行设置 Content-Disposition 为 attachment，命令浏览器直接下载而不是播放
        headers.set('Content-Disposition', `attachment; filename="SonyaHolic_Video_${Date.now()}.mp4"`);
        
        // 【核心黑科技 2】：强行把视频伪装成二进制未知文件流，彻底干掉 Safari 的自动全屏播放器
        headers.set('Content-Type', 'application/octet-stream');

        // 将视频数据流高速转发给手机端
        return new Response(response.body, {
            status: 200,
            headers: headers
        });
    } catch (error) {
        return new Response('服务器代理错误', { status: 500 });
    }
}