// ========== Cloudflare Worker ==========
// 绑定KV命名空间: 在wrangler.toml中配置

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const method = request.method;

        // ---------- 处理OPTIONS预检（CORS） ----------
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

        // ---------- GET请求：管理后台拉取数据 ----------
        if (method === 'GET') {
            const adminKey = url.searchParams.get('key');
            const isAdmin = url.searchParams.get('admin');

            // 验证管理员密钥
            const VALID_KEY = 'Lucky2026@Secure!'; // ⚠️ 必须与admin.html中的密钥一致
            if (isAdmin === 'true' && adminKey === VALID_KEY) {
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

            // 非管理员访问，返回404伪装
            return new Response('Not Found', { 
                status: 404,
                headers: { 'Access-Control-Allow-Origin': '*' }
            });
        }

        // ---------- POST请求：接收数据 ----------
        if (method === 'POST') {
            try {
                const body = await request.json();
                
                // 获取真实IP（Cloudflare自动处理）
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

        // 其他方法返回404
        return new Response('Not Found', { 
            status: 404,
            headers: { 'Access-Control-Allow-Origin': '*' }
        });
    },
};

// ---------- KV操作函数 ----------
async function saveRecord(env, record) {
    // 使用活动ID作为key的一部分，方便分类
    const key = `record_${record.activityId}_${record.id}`;
    await env.MY_KV.put(key, JSON.stringify(record), {
        expirationTtl: 2592000, // 30天后自动过期（节省存储）
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