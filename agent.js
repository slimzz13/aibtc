const { spawn } = require('child_process');

// Start the aibtc mcp server and bind to it
const mcp = spawn('npx.cmd', ['@aibtc/mcp-server']);
let callId = 1;

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
        arguments: { password: "Akinwande@60" } // Warning: do not leak this repo if this is sensitive!
    });
}, 3000);

// Daily schedule loops 
setInterval(() => {
    console.log("==> Sending Heartbeat...");
    // Assuming heartbeat tool or sign message is configured here.
}, 1000 * 60 * 5); // 5 mins

console.log("Agent Loop Initialized. Waiting for MCP Server to start...");
