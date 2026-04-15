const { spawn } = require('child_process');
const http = require('http');
const cron = require('node-cron');

// Render Web Service Health Check
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('AIBTC Agent is running natively!');
}).listen(PORT, () => {
    console.log(`Web service listening on port ${PORT} for Render health checks.`);
});

// Start the aibtc mcp server and bind to it
const mcp = spawn(/^win/.test(process.platform) ? 'npx.cmd' : 'npx', ['@aibtc/mcp-server'], { shell: true });
let callId = 1;

// Self-Ping Uptime Bot (Keeps Render Free Tier Awake)
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (url) {
        http.get(url, (res) => {
            console.log(`[Uptime Bot] Self-ping successful: ${res.statusCode}`);
        }).on('error', (e) => {
            console.error(`[Uptime Bot] Self-ping failed: ${e.message}`);
        });
    } else {
        console.log("[Uptime Bot] Running locally. Skipping self-ping.");
    }
}, 1000 * 60 * 14); // Ping every 14 minutes

const pendingCalls = new Map();
let rpcBuffer = '';

function rpcCall(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = callId++;
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            method,
            id,
            params
        });
        pendingCalls.set(id, { resolve, reject });
        console.log(`[>> RPC OUT ID:${id}]: Method: ${method}`);
        mcp.stdin.write(payload + '\n');
    });
}

mcp.stdout.on('data', (data) => {
    rpcBuffer += data.toString();
    const lines = rpcBuffer.split('\n');
    rpcBuffer = lines.pop(); // keep incomplete line
    
    for (const line of lines) {
        if (!line.trim()) continue;
        console.log(`[<< RPC IN]: ${line}`);
        try {
            const resp = JSON.parse(line);
            if (resp.id && pendingCalls.has(resp.id)) {
                if (resp.error) {
                    pendingCalls.get(resp.id).reject(new Error(JSON.stringify(resp.error)));
                } else if (resp.result && resp.result.isError) {
                    const errMsg = resp.result.content ? JSON.stringify(resp.result.content) : "Unknown MCP Error";
                    pendingCalls.get(resp.id).reject(new Error(`MCP Tool Error: ${errMsg}`));
                } else {
                    pendingCalls.get(resp.id).resolve(resp.result);
                }
                pendingCalls.delete(resp.id);
            }
        } catch (e) {
            // Unparseable (might be non-JSON logs from the MCP server)
        }
    }
});

mcp.stderr.on('data', (data) => {
    console.error(`[!! RPC ERR]: ${data.toString().trim()}`);
});

// Boot Sequence
setTimeout(async () => {
    console.log("==> Unlocking Wallet...");
    try {
        await rpcCall("tools/call", {
            name: "wallet_unlock",
            arguments: { password: process.env.WALLET_PASSWORD } // Securely read from Render environment variables
        });
        console.log("==> Wallet Unlocked successfully.");
    } catch (err) {
        console.error("==> Wallet Unlock failed:", err.message);
    }
}, 3000);

// Signal posting schedule — times in UTC (user is PDT = UTC-7):
// 09:00 PDT = 16:00 UTC  (Morning)
// 13:00 PDT = 20:00 UTC  (Afternoon)
// 18:00 PDT = 01:00 UTC  (Evening, next UTC day)
async function postNewsSignal() {
    const now = new Date().toISOString();
    console.log(`==> [${now}] Running news signal logic...`);

    try {
        // Step 1: Re-unlock wallet (in case session expired)
        console.log("==> Unlocking Wallet...");
        await rpcCall("tools/call", {
            name: "wallet_unlock",
            arguments: { password: process.env.WALLET_PASSWORD }
        });

        // Step 2: Search arxiv for fresh AIBTC-relevant research
        console.log("==> Searching for fresh AIBTC/Stacks security research...");
        const arxivResponse = await rpcCall("tools/call", {
            name: "arxiv_search",
            arguments: { categories: "cs.CR,cs.AI", max_results: 1 }
        });
        
        console.log("==> Arxiv Search Results:", JSON.stringify(arxivResponse).substring(0, 200) + "...");
        
        // Extract basic data from tool output if available
        const arxivText = typeof arxivResponse === 'object' && arxivResponse.text ? arxivResponse.text : JSON.stringify(arxivResponse);

        // Step 3: Compile News Signal
        console.log("==> Compiling News Signal Wrapper...");
        const mockHeadline = "Latest Advances in Bitcoin & AI Security (Arxiv)";
        const mockSummary = `Detected new publication relevant to cs.CR/cs.AI. Summary: ${arxivText.substring(0, 150)}...`;
        
        // Step 4: Submit Signal
        console.log("==> Submitting News Signal via aibtc_news...");
        const submitResult = await rpcCall("tools/call", {
            name: "aibtc_news_submit", // Update if the tool name differs based on `npx skills list`
            arguments: {
                headline: mockHeadline,
                summary: mockSummary,
                source: "https://arxiv.org",
                publisher: "bc1qktaz6rg5k4smre0wfde2tjs2eupvggpmdz39ku"
            }
        });
        
        console.log(`==> SUCCESS! Signal Posted:`, submitResult);

    } catch (err) {
        console.error("==> Bot logic encountered an error:", err.message);
    }
}

cron.schedule('0 16,20,1 * * *', () => postNewsSignal(), { timezone: "UTC" });

if (process.argv.includes('--run-now')) {
    setTimeout(async () => {
        console.log("==> OVERRIDE: Executing immediate one-off signal run...");
        await postNewsSignal();
        process.exit(0);
    }, 4500); // 4.5s delay to ensure mcp boots cleanly first
}

console.log("Agent Loop Initialized. Waiting for MCP Server to start...");
