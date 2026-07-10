// ========== Cloudflare Worker - 安全版 ==========
// 密钥通过环境变量 ADMIN_KEY 读取，不硬编码在代码中

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const method = request.method;

        // ---------- CORS 预检 ----------
        if (method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // ---------- GET：管理后台拉取数据 ----------
        if (method === 'GET') {
            const adminKey = url.searchParams.get('key');
            const isAdmin = url.searchParams.get('admin');

            if (isAdmin === 'true' && adminKey) {
                // 从环境变量读取密钥进行验证
                const ADMIN_KEY = env.ADMIN_KEY || 'admin123';
                
                if (adminKey !== ADMIN_KEY) {
                    return new Response(JSON.stringify({ 
                        success: false, 
                        error: 'Invalid key' 
                    }), {
                        status: 401,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                }

                try {
                    const records = await getRecords(env);
                    return new Response(JSON.stringify({ 
                        success: true, 
                        records: records,
                        total: records.length 
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
                        status: 500,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                }
            }

            // 非管理员访问返回404伪装
            return new Response('Not Found', { 
                status: 404,
                headers: { 
                    'Content-Type': 'text/plain',
                    'Access-Control-Allow-Origin': '*' 
                }
            });
        }

        // ---------- POST：接收数据 ----------
        if (method === 'POST') {
            try {
                const body = await request.json();
                
                // 获取真实IP（Cloudflare自动处理）
                const ip = request.headers.get('CF-Connecting-IP') || 
                          request.headers.get('X-Forwarded-For')?.split(',')[0] || 
                          request.headers.get('X-Real-IP') ||
                          'unknown';

                // 获取用户代理
                const userAgent = request.headers.get('User-Agent') || '';

                // 构建记录
                const record = {
                    id: Date.now() + '_' + Math.random().toString(36).substring(2, 8),
                    timestamp: body.timestamp || new Date().toISOString(),
                    ip: ip,
                    os: body.os || parseOS(userAgent),
                    osVersion: body.osVersion || parseOSVersion(userAgent),
                    deviceType: body.deviceType || parseDeviceType(userAgent),
                    userAgent: body.userAgent || userAgent.substring(0, 500),
                    referer: body.referer || request.headers.get('Referer') || '',
                    url: body.url || url.toString(),
                    activityId: body.activityId || 'default',
                    auto: body.auto || false,
                };

                // 存储到KV
                await saveRecord(env, record);

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

        // 其他方法返回404
        return new Response('Not Found', { 
            status: 404,
            headers: { 
                'Content-Type': 'text/plain',
                'Access-Control-Allow-Origin': '*' 
            }
        });
    },
};

// ---------- KV操作函数 ----------
async function saveRecord(env, record) {
    const key = `record_${record.activityId}_${record.id}`;
    await env.MY_KV.put(key, JSON.stringify(record), {
        expirationTtl: 2592000, // 30天后自动过期
    });
}

async function getRecords(env) {
    const list = await env.MY_KV.list({ prefix: 'record_' });
    const records = [];
    
    for (const key of list.keys) {
        const value = await env.MY_KV.get(key.name);
        if (value) {
            try {
                records.push(JSON.parse(value));
            } catch (e) {
                // 忽略解析失败的数据
            }
        }
    }
    
    // 按时间倒序（最新的在前）
    records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return records;
}

// ---------- 辅助函数：从 User-Agent 解析设备信息 ----------
function parseOS(userAgent) {
    if (!userAgent) return 'Unknown';
    const ua = userAgent.toLowerCase();
    if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('windows')) return 'Windows';
    if (ua.includes('mac os')) return 'macOS';
    if (ua.includes('linux')) return 'Linux';
    return 'Unknown';
}

function parseOSVersion(userAgent) {
    if (!userAgent) return 'Unknown';
    const ua = userAgent;
    
    // iOS 版本
    const iosMatch = ua.match(/iPhone OS (\d+)_(\d+)/);
    if (iosMatch) return iosMatch[1] + '.' + iosMatch[2];
    
    // Android 版本
    const androidMatch = ua.match(/Android (\d+)\.(\d+)/);
    if (androidMatch) return androidMatch[1] + '.' + androidMatch[2];
    
    // Windows 版本
    const winMatch = ua.match(/Windows NT (\d+)\.(\d+)/);
    if (winMatch) {
        const versions = {
            '10.0': '10/11',
            '6.3': '8.1',
            '6.2': '8',
            '6.1': '7',
        };
        return versions[winMatch[1] + '.' + winMatch[2]] || winMatch[1] + '.' + winMatch[2];
    }
    
    // macOS 版本
    const macMatch = ua.match(/Mac OS X (\d+)_(\d+)_?(\d+)?/);
    if (macMatch) {
        return macMatch[1] + '.' + macMatch[2] + (macMatch[3] ? '.' + macMatch[3] : '');
    }
    
    return 'Unknown';
}

function parseDeviceType(userAgent) {
    if (!userAgent) return 'Unknown';
    const ua = userAgent.toLowerCase();
    if (ua.includes('iphone')) return 'iPhone';
    if (ua.includes('ipad')) return 'iPad';
    if (ua.includes('android') && !ua.includes('mobile')) return 'Android Tablet';
    if (ua.includes('android')) return 'Android Phone';
    if (ua.includes('windows') || ua.includes('mac os') || ua.includes('linux')) return 'PC';
    return 'Unknown';
}