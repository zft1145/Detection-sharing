// ========== Cloudflare Worker ==========
// 支持创建追踪链接 + 自动记录访问

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const method = request.method;
        const path = url.pathname;

        // ---------- CORS 预检 ----------
        if (method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // ============================================================
        // 1. 后台管理：生成追踪链接 (POST /admin/create)
        // ============================================================
        if (method === 'POST' && path === '/admin/create') {
            const ADMIN_KEY = env.ADMIN_KEY || 'admin123';
            const body = await request.json();
            const adminKey = body.key;

            // 验证管理员密钥
            if (adminKey !== ADMIN_KEY) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Invalid admin key'
                }), {
                    status: 401,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }

            // 生成唯一短码
            const shortCode = generateShortCode();
            const targetUrl = body.targetUrl || 'https://cjblts.zft1145.top/index.html';
            const activityName = body.activityName || '未命名活动';
            const createdAt = new Date().toISOString();

            // 保存链接信息到 KV
            const linkData = {
                shortCode: shortCode,
                targetUrl: targetUrl,
                activityName: activityName,
                createdAt: createdAt,
                visits: 0,
                creator: body.creator || 'admin',
                enabled: true,
            };

            await env.MY_KV.put(`link_${shortCode}`, JSON.stringify(linkData));

            // 返回生成的链接
            const fullUrl = `${url.origin}/l/${shortCode}`;
            
            return new Response(JSON.stringify({
                success: true,
                shortCode: shortCode,
                url: fullUrl,
                adminUrl: `${url.origin}/admin/stats/${shortCode}`,
                data: linkData
            }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // ============================================================
        // 2. 访问追踪链接 (GET /l/:shortCode)
        // ============================================================
        if (method === 'GET' && path.startsWith('/l/')) {
            const shortCode = path.replace('/l/', '');
            
            // 获取链接信息
            const linkDataStr = await env.MY_KV.get(`link_${shortCode}`);
            if (!linkDataStr) {
                return new Response('链接不存在或已失效', {
                    status: 404,
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' }
                });
            }

            const linkData = JSON.parse(linkDataStr);
            
            // 检查链接是否启用
            if (linkData.enabled === false) {
                return new Response('此链接已被禁用', {
                    status: 403,
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' }
                });
            }

            // ---------- 记录访问数据 ----------
            const ip = request.headers.get('CF-Connecting-IP') ||
                      request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                      request.headers.get('X-Real-IP') ||
                      'unknown';

            const userAgent = request.headers.get('User-Agent') || '';
            const referer = request.headers.get('Referer') || '';

            // 解析设备信息
            const deviceInfo = parseDeviceInfo(userAgent);

            const visitRecord = {
                id: Date.now() + '_' + Math.random().toString(36).substring(2, 8),
                shortCode: shortCode,
                activityName: linkData.activityName,
                timestamp: new Date().toISOString(),
                ip: ip,
                os: deviceInfo.os,
                osVersion: deviceInfo.osVersion,
                deviceType: deviceInfo.deviceType,
                userAgent: userAgent.substring(0, 500),
                referer: referer,
                targetUrl: linkData.targetUrl,
            };

            // 保存访问记录
            await env.MY_KV.put(`visit_${shortCode}_${visitRecord.id}`, JSON.stringify(visitRecord), {
                expirationTtl: 2592000, // 30天
            });

            // 更新访问计数
            linkData.visits = (linkData.visits || 0) + 1;
            await env.MY_KV.put(`link_${shortCode}`, JSON.stringify(linkData));

            // ---------- 跳转到目标页面 ----------
            return Response.redirect(linkData.targetUrl, 302);
        }

        // ============================================================
        // 3. 查看链接统计数据 (GET /admin/stats/:shortCode)
        // ============================================================
        if (method === 'GET' && path.startsWith('/admin/stats/')) {
            const shortCode = path.replace('/admin/stats/', '');
            const adminKey = url.searchParams.get('key');
            const ADMIN_KEY = env.ADMIN_KEY || 'admin123';

            if (adminKey !== ADMIN_KEY) {
                return new Response('Unauthorized', { status: 401 });
            }

            // 获取链接信息
            const linkDataStr = await env.MY_KV.get(`link_${shortCode}`);
            if (!linkDataStr) {
                return new Response(JSON.stringify({ error: '链接不存在' }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const linkData = JSON.parse(linkDataStr);

            // 获取所有访问记录
            const visits = [];
            const list = await env.MY_KV.list({ prefix: `visit_${shortCode}_` });
            for (const key of list.keys) {
                const value = await env.MY_KV.get(key.name);
                if (value) {
                    try {
                        visits.push(JSON.parse(value));
                    } catch (e) {}
                }
            }

            // 按时间排序（最新在前）
            visits.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            return new Response(JSON.stringify({
                success: true,
                link: linkData,
                visits: visits,
                totalVisits: visits.length
            }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // ============================================================
        // 4. 获取所有链接列表 (GET /admin/links)
        // ============================================================
        if (method === 'GET' && path === '/admin/links') {
            const adminKey = url.searchParams.get('key');
            const ADMIN_KEY = env.ADMIN_KEY || 'admin123';

            if (adminKey !== ADMIN_KEY) {
                return new Response('Unauthorized', { status: 401 });
            }

            const links = [];
            const list = await env.MY_KV.list({ prefix: 'link_' });
            for (const key of list.keys) {
                const value = await env.MY_KV.get(key.name);
                if (value) {
                    try {
                        links.push(JSON.parse(value));
                    } catch (e) {}
                }
            }

            links.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            return new Response(JSON.stringify({
                success: true,
                links: links,
                total: links.length
            }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        // ============================================================
        // 5. 兼容旧版：直接 POST 数据上报
        // ============================================================
        if (method === 'POST' && path === '/') {
            try {
                const body = await request.json();
                const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
                const userAgent = request.headers.get('User-Agent') || '';
                const deviceInfo = parseDeviceInfo(userAgent);

                const record = {
                    id: Date.now() + '_' + Math.random().toString(36).substring(2, 8),
                    timestamp: body.timestamp || new Date().toISOString(),
                    ip: ip,
                    os: body.os || deviceInfo.os,
                    osVersion: body.osVersion || deviceInfo.osVersion,
                    deviceType: body.deviceType || deviceInfo.deviceType,
                    userAgent: body.userAgent || userAgent.substring(0, 500),
                    referer: body.referer || '',
                    url: body.url || '',
                    activityId: body.activityId || 'default',
                    auto: body.auto || false,
                };

                await env.MY_KV.put(`record_${record.id}`, JSON.stringify(record), {
                    expirationTtl: 2592000,
                });

                return new Response(JSON.stringify({
                    success: true,
                    message: 'Data recorded',
                    id: record.id
                }), {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            } catch (err) {
                return new Response(JSON.stringify({
                    success: false,
                    error: err.message
                }), {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }
        }

        // ============================================================
        // 默认：返回 404
        // ============================================================
        return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' }
        });
    },
};

// ============================================================
// 辅助函数
// ============================================================

// 生成短码（6位随机字符串）
function generateShortCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// 解析设备信息
function parseDeviceInfo(userAgent) {
    if (!userAgent) return { os: 'Unknown', osVersion: 'Unknown', deviceType: 'Unknown' };
    const ua = userAgent;
    
    let os = 'Unknown';
    let osVersion = 'Unknown';
    let deviceType = 'Unknown';

    // iOS
    const iosMatch = ua.match(/iPhone OS (\d+)_(\d+)/);
    if (iosMatch) {
        os = 'iOS';
        osVersion = iosMatch[1] + '.' + iosMatch[2];
        deviceType = 'iPhone';
        return { os, osVersion, deviceType };
    }
    
    if (ua.includes('iPad')) {
        os = 'iOS';
        osVersion = 'iPad';
        deviceType = 'iPad';
        return { os, osVersion, deviceType };
    }

    // Android
    const androidMatch = ua.match(/Android (\d+)\.(\d+)/);
    if (androidMatch) {
        os = 'Android';
        osVersion = androidMatch[1] + '.' + androidMatch[2];
        deviceType = ua.includes('Mobile') ? 'Android Phone' : 'Android Tablet';
        return { os, osVersion, deviceType };
    }

    // Windows
    if (ua.includes('Windows')) {
        os = 'Windows';
        const winMatch = ua.match(/Windows NT (\d+)\.(\d+)/);
        if (winMatch) {
            const versions = {
                '10.0': '10/11',
                '6.3': '8.1',
                '6.2': '8',
                '6.1': '7',
            };
            osVersion = versions[winMatch[1] + '.' + winMatch[2]] || winMatch[1] + '.' + winMatch[2];
        }
        deviceType = 'PC';
        return { os, osVersion, deviceType };
    }

    // macOS
    if (ua.includes('Mac OS X')) {
        os = 'macOS';
        const macMatch = ua.match(/Mac OS X (\d+)_(\d+)_?(\d+)?/);
        if (macMatch) {
            osVersion = macMatch[1] + '.' + macMatch[2] + (macMatch[3] ? '.' + macMatch[3] : '');
        }
        deviceType = 'PC';
        return { os, osVersion, deviceType };
    }

    // Linux
    if (ua.includes('Linux')) {
        os = 'Linux';
        deviceType = 'PC';
        return { os, osVersion, deviceType };
    }

    return { os, osVersion, deviceType };
}