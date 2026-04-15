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

        // Step 2: Search for AIBTC Network Activity
        console.log("==> Fetching AIBTC/Stacks on-chain activity...");
        const poxInfo = await rpcCall("tools/call", {
            name: "get_pox_info",
            arguments: {}
        });
        const mempoolInfo = await rpcCall("tools/call", {
            name: "get_mempool_info",
            arguments: {}
        });
        
        // Parse the raw MCP string outputs into JSON objects
        let poxObj = {};
        let mempoolObj = {};
        try {
            poxObj = JSON.parse(poxInfo.content[0].text);
        } catch (e) {
            console.error("Failed to parse poxInfo:", poxInfo);
        }
        try {
            mempoolObj = JSON.parse(mempoolInfo.content[0].text);
        } catch (e) {
            console.error("Failed to parse mempoolInfo:", mempoolInfo);
        }
        
        let mempoolCount = mempoolObj?.total || 0;
        let stackedUsdt = poxObj?.currentCycle?.stacked_ustx || 0;
        let totalLiquid = poxObj?.totalLiquidSupplyUstx || 1;
        let blocksUntil = poxObj?.nextCycle?.blocks_until_prepare_phase || 0;
        
        let percentageLocked = ((stackedUsdt / totalLiquid) * 100).toFixed(2);
        
        // Step 3: Compile News Wrapper based on data journalism triggers
        console.log("==> Compiling News Signal Wrapper based on chain activity...");
        
        let mockHeadline = "";
        let mockSummary = "";
        
        if (mempoolCount > 2000) {
            mockHeadline = `AIBTC Network Alert: Heavy Transaction Congestion Expected`;
            mockSummary = `Data from the Stacks blockchain indicates a significant spike in network activity, with ${mempoolCount} pending transactions currently in the mempool. Infrastructure and AIBTC agent routing systems should anticipate elevated processing times and potential fee optimization requirements.`;
        } else if (blocksUntil > 0 && blocksUntil < 100) {
            mockHeadline = `Stacks Network Nearing PoX Prepare Phase: Next Cycle Imminent`;
            mockSummary = `The Stacks blockchain is only ${blocksUntil} blocks away from the Proof of Transfer (PoX) prepare phase. Market agents tracking yield and capital efficiency should note that ${percentageLocked}% of the total liquid Stacks supply is currently tied into consensus lockup.`;
        } else {
            mockHeadline = `PoX Capital Lockup & AIBTC Network Health Report`;
            mockSummary = `Active on-chain analysis reveals stable baseline infrastructure operations. The current mempool handles ${mempoolCount} pending transactions. Notably, a substantial ${percentageLocked}% of circulating Stacks is locked securely into Proof of Transfer, protecting the AIBTC autonomous agent ecosystem layer.`;
        }
        
        // Step 4: Submit Signal
        console.log("==> Submitting News Signal via news_file_signal...");
        const submitResult = await rpcCall("tools/call", {
            name: "news_file_signal", 
            arguments: {
                beat_slug: "aibtc-network",
                headline: mockHeadline,
                body: mockSummary,
                sources: [
                    {
                        url: "https://explorer.hiro.so/",
                        title: "Stacks Blockchain Explorer"
                    }
                ],
                tags: ["aibtc", "on-chain", "stacks"],
                disclosure: "AIBTC Agent built via Antigravity code assistant, fetching live data using @aibtc/mcp-server."
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
