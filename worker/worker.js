// ========== Cloudflare Worker ==========
// 自定义域名: fxyzapi.zft1145.top

// 密钥（使用SHA-256加密存储）
const ADMIN_KEY_HASH = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'; // 'admin123' 的SHA-256

// 验证密钥
async function verifyKey(key) {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === ADMIN_KEY_HASH;
}

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
                // 验证密钥
                const isValid = await verifyKey(adminKey);
                if (!isValid) {
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

            // 非管理员访问返回404
            return new Response('Not Found', { 
                status: 404,
                headers: { 'Access-Control-Allow-Origin': '*' }
            });
        }

        // ---------- POST：接收数据 ----------
        if (method === 'POST') {
            try {
                const body = await request.json();
                
                // 获取真实IP
                const ip = request.headers.get('CF-Connecting-IP') || 
                          request.headers.get('X-Forwarded-For')?.split(',')[0] || 
                          'unknown';

                // 构建记录
                const record = {
                    id: Date.now() + '_' + Math.random().toString(36).substring(2, 8),
                    timestamp: body.timestamp || new Date().toISOString(),
                    ip: ip,
                    os: body.os || 'Unknown',
                    osVersion: body.osVersion || 'Unknown',
                    deviceType: body.deviceType || 'Unknown',
                    userAgent: body.userAgent || '',
                    referer: body.referer || '',
                    url: body.url || '',
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

        return new Response('Not Found', { 
            status: 404,
            headers: { 'Access-Control-Allow-Origin': '*' }
        });
    },
};

// ---------- KV操作函数 ----------
async function saveRecord(env, record) {
    const key = `record_${record.activityId}_${record.id}`;
    await env.MY_KV.put(key, JSON.stringify(record), {
        expirationTtl: 2592000, // 30天
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
            } catch (e) {}
        }
    }
    
    records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return records;
}