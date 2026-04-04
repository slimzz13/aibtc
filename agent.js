const { spawn } = require('child_process');
const http = require('http');

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

function rpcCall(method, params = {}) {
    const payload = JSON.stringify({
        jsonrpc: "2.0",
        method,
        id: callId++,
        params
    });
    console.log(`[>> RPC OUT]: Method: ${method}`);
    mcp.stdin.write(payload + '\n');
}

mcp.stdout.on('data', (data) => {
    const str = data.toString();
    console.log(`[<< RPC IN]: ${str}`);
});

mcp.stderr.on('data', (data) => {
    console.error(`[!! RPC ERR]: ${data.toString()}`);
});

// Boot Sequence
setTimeout(() => {
    console.log("==> Unlocking Wallet...");
    rpcCall("tools/call", {
        name: "wallet_unlock",
        arguments: { password: process.env.WALLET_PASSWORD } // Securely read from Render environment variables
    });
}, 3000);

// Daily schedule loops 
setInterval(() => {
    console.log("==> Sending Heartbeat...");
    // Assuming heartbeat tool or sign message is configured here.
}, 1000 * 60 * 5); // 5 mins

console.log("Agent Loop Initialized. Waiting for MCP Server to start...");
