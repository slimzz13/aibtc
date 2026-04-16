const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
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

// ----- GitHub API Helper -----
// Fetches recent events from the aibtcdev GitHub organization (public, no auth required)
function fetchGitHubEvents() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/orgs/aibtcdev/events?per_page=30',
            headers: { 'User-Agent': 'aibtc-agent-bot/1.0' }
        };
        https.get(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Failed to parse GitHub events JSON')); }
            });
        }).on('error', reject);
    });
}

// ----- Signal Composition Engine -----
// Analyzes raw GitHub events and composes a newsworthy signal
function composeSignalFromEvents(events) {
    // Filter events from the last 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = events.filter(e => new Date(e.created_at) > cutoff);

    // Categorize events
    const mergedPRs = recent.filter(e => e.type === 'PullRequestEvent' && e.payload?.action === 'merged');
    const openedPRs = recent.filter(e => e.type === 'PullRequestEvent' && e.payload?.action === 'opened');
    const pushes = recent.filter(e => e.type === 'PushEvent');
    const issueComments = recent.filter(e => e.type === 'IssueCommentEvent');
    const newIssues = recent.filter(e => e.type === 'IssuesEvent' && e.payload?.action === 'opened');

    // Identify unique repos touched
    const reposSet = new Set(recent.map(e => e.repo?.name?.replace('aibtcdev/', '') || 'unknown'));
    const repos = [...reposSet];

    // Identify unique contributors
    const contributorsSet = new Set(recent.map(e => e.actor?.login).filter(Boolean));
    const contributors = [...contributorsSet].filter(c => !c.includes('[bot]'));

    // Build sources array from actual GitHub URLs
    const sources = [];
    if (mergedPRs.length > 0) {
        const pr = mergedPRs[0];
        const prNum = pr.payload?.number;
        const repoName = pr.repo?.name;
        sources.push({
            url: `https://github.com/${repoName}/pull/${prNum}`,
            title: `${repoName.replace('aibtcdev/', '')} PR #${prNum} (merged)`
        });
    }
    if (newIssues.length > 0) {
        const issue = newIssues[0];
        const issNum = issue.payload?.issue?.number;
        const repoName = issue.repo?.name;
        sources.push({
            url: `https://github.com/${repoName}/issues/${issNum}`,
            title: `${repoName.replace('aibtcdev/', '')} Issue #${issNum}`
        });
    }
    if (issueComments.length > 0 && sources.length < 3) {
        const comment = issueComments[0];
        const issNum = comment.payload?.issue?.number;
        const repoName = comment.repo?.name;
        sources.push({
            url: `https://github.com/${repoName}/issues/${issNum}`,
            title: `${repoName.replace('aibtcdev/', '')} Issue #${issNum} discussion`
        });
    }
    // Fallback source
    if (sources.length === 0) {
        sources.push({
            url: 'https://github.com/aibtcdev',
            title: 'aibtcdev GitHub Organization'
        });
    }
    // Cap at 5 sources
    sources.splice(5);

    // Build tags
    const tags = ['aibtc'];
    if (repos.includes('skills')) tags.push('skills');
    if (repos.includes('agent-news')) tags.push('agent-news');
    if (repos.includes('aibtc-mcp-server')) tags.push('mcp-server');
    if (repos.includes('x402-api')) tags.push('x402');
    if (mergedPRs.length > 0) tags.push('development');
    if (tags.length < 2) tags.push('infrastructure');

    // Compose headline and body dynamically
    let headline = '';
    let body = '';
    const today = new Date().toISOString().split('T')[0];

    if (mergedPRs.length > 0) {
        const topPR = mergedPRs[0];
        const prTitle = topPR.payload?.pull_request?.head?.ref?.replace(/-/g, ' ') || 'feature update';
        const prRepo = topPR.repo?.name?.replace('aibtcdev/', '') || 'unknown';
        headline = `aibtcdev/${prRepo}: ${mergedPRs.length} PR${mergedPRs.length > 1 ? 's' : ''} Merged — Active Development on ${today}`;
        body = `The aibtcdev GitHub organization merged ${mergedPRs.length} pull request${mergedPRs.length > 1 ? 's' : ''} in the last 24 hours across ${repos.length} repositor${repos.length > 1 ? 'ies' : 'y'} (${repos.join(', ')}). `;
        body += `${contributors.length} contributor${contributors.length > 1 ? 's' : ''} (${contributors.slice(0, 5).join(', ')}) pushed code. `;
        if (openedPRs.length > 0) body += `${openedPRs.length} new PR${openedPRs.length > 1 ? 's were' : ' was'} also opened. `;
        if (issueComments.length > 0) body += `${issueComments.length} issue comment${issueComments.length > 1 ? 's' : ''} show active community discussion. `;
        body += `This signals continued investment in aibtc agent infrastructure and tooling.`;
    } else if (pushes.length > 0) {
        headline = `aibtcdev Development Pulse: ${pushes.length} Code Push${pushes.length > 1 ? 'es' : ''} Across ${repos.length} Repo${repos.length > 1 ? 's' : ''} on ${today}`;
        body = `The aibtcdev organization recorded ${pushes.length} code push${pushes.length > 1 ? 'es' : ''} in the last 24 hours to ${repos.join(', ')}. `;
        body += `${contributors.length} active contributor${contributors.length > 1 ? 's' : ''} (${contributors.slice(0, 5).join(', ')}) committed changes. `;
        if (issueComments.length > 0) body += `Additionally, ${issueComments.length} issue comment${issueComments.length > 1 ? 's' : ''} indicate ongoing design discussion. `;
        body += `Steady commit velocity reflects active iteration on aibtc agent skills and network tooling.`;
    } else if (issueComments.length > 0 || newIssues.length > 0) {
        headline = `aibtcdev Community Activity: ${newIssues.length} New Issue${newIssues.length !== 1 ? 's' : ''} and ${issueComments.length} Comment${issueComments.length !== 1 ? 's' : ''} on ${today}`;
        body = `The aibtcdev GitHub organization saw ${issueComments.length} issue comment${issueComments.length > 1 ? 's' : ''} and ${newIssues.length} new issue${newIssues.length > 1 ? 's' : ''} filed in the last 24 hours. `;
        body += `Active repositories: ${repos.join(', ')}. Contributors: ${contributors.slice(0, 5).join(', ')}. `;
        body += `This community engagement drives the aibtc agent economy roadmap forward.`;
    } else {
        // Fallback: report on whatever events exist
        headline = `aibtcdev Organization Activity Summary — ${today}`;
        body = `The aibtcdev GitHub organization recorded ${recent.length} event${recent.length !== 1 ? 's' : ''} across ${repos.join(', ')} in the last 24 hours. `;
        body += `Contributors active: ${contributors.slice(0, 5).join(', ') || 'none detected'}. `;
        body += `Monitoring continues for PRs, issues, and agent infrastructure developments.`;
    }

    // Truncate to API limits
    headline = headline.substring(0, 120);
    body = body.substring(0, 1000);

    return { headline, body, sources, tags };
}

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

// ----- Main Signal Logic -----
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

        // Step 2: Fetch live aibtcdev GitHub organization events
        console.log("==> Fetching aibtcdev GitHub org events...");
        const events = await fetchGitHubEvents();
        console.log(`==> Fetched ${events.length} events from GitHub`);

        // Step 3: Compose signal from real events
        console.log("==> Composing signal from GitHub activity...");
        const signal = composeSignalFromEvents(events);
        console.log(`==> Headline: ${signal.headline}`);
        console.log(`==> Body: ${signal.body}`);
        console.log(`==> Sources: ${JSON.stringify(signal.sources)}`);
        console.log(`==> Tags: ${signal.tags}`);

        // Step 4: Submit Signal
        console.log("==> Submitting News Signal via news_file_signal...");
        const submitResult = await rpcCall("tools/call", {
            name: "news_file_signal", 
            arguments: {
                beat_slug: "aibtc-network",
                headline: signal.headline,
                body: signal.body,
                sources: signal.sources,
                tags: signal.tags,
                disclosure: "Automated aibtc agent — data sourced from aibtcdev GitHub org public events API."
            }
        });
        
        console.log(`==> SUCCESS! Signal Posted:`, submitResult);

    } catch (err) {
        console.error("==> Bot logic encountered an error:", err.message);
    }
}

// Schedule: 08:00, 14:00, 22:00 UTC (all before 23:00 UTC cutoff)
cron.schedule('0 8,14,22 * * *', () => postNewsSignal(), { timezone: "UTC" });

if (process.argv.includes('--run-now')) {
    setTimeout(async () => {
        console.log("==> OVERRIDE: Executing immediate one-off signal run...");
        await postNewsSignal();
        process.exit(0);
    }, 4500); // 4.5s delay to ensure mcp boots cleanly first
}

console.log("Agent Loop Initialized. Waiting for MCP Server to start...");
