const protobuf = require('protobufjs');
const WebSocket = require('ws');

const root = new protobuf.Root();
root.loadSync('base.proto');
root.loadSync('request_rithmic_system_info.proto');
root.loadSync('response_rithmic_system_info.proto');
root.loadSync('request_login.proto');
root.loadSync('response_login.proto');
root.loadSync('request_market_data_update.proto');
root.loadSync('response_market_data_update.proto');
root.loadSync('last_trade.proto');
root.loadSync('best_bid_offer.proto');
root.loadSync('request_heartbeat.proto');
root.loadSync('response_heartbeat.proto');

function encode(typeName, obj) {
    const T = root.lookupType(typeName);
    return Buffer.from(T.encode(T.create(obj)).finish());
}
function decode(typeName, buf) {
    return root.lookupType(typeName).decode(buf);
}

(async () => {
    const t0 = Date.now();
    const ws = new WebSocket('wss://rituz00100.rithmic.com:443', { rejectUnauthorized: false });
    await new Promise(r => ws.on('open', r));
    const connectMs = Date.now() - t0;
    console.log(`Connected in ${connectMs}ms`);

    // Login
    const RequestLogin = root.lookupType('RequestLogin');
    const loginStart = Date.now();
    ws.send(encode('RequestLogin', {
        templateId: 10, templateVersion: '3.9', userMsg: ['test'],
        user: 'njliautaud@gmail.com', password: 'MA8KTPiV',
        appName: 'TeleClaude', appVersion: '1.0.0',
        systemName: 'Rithmic Test', infraType: RequestLogin.SysInfraType.TICKER_PLANT
    }));
    let resp = await new Promise(r => ws.once('message', r));
    const loginMs = Date.now() - loginStart;
    const login = decode('ResponseLogin', resp);
    console.log(`Login rpCode: ${login.rpCode[0]} (${loginMs}ms)`);

    // Subscribe to ES June 2026
    const RequestMD = root.lookupType('RequestMarketDataUpdate');
    ws.send(encode('RequestMarketDataUpdate', {
        templateId: 100, userMsg: ['sub'], symbol: 'ESM6', exchange: 'CME',
        request: RequestMD.Request.SUBSCRIBE,
        updateBits: RequestMD.UpdateBits.LAST_TRADE | RequestMD.UpdateBits.BBO
    }));

    let msgCount = 0;
    let trades = 0;
    let bbos = 0;
    let firstMsgTime = null;

    ws.on('message', (data) => {
        const base = decode('Base', data);
        msgCount++;
        if (!firstMsgTime) firstMsgTime = Date.now();

        if (base.templateId === 101) {
            const r = decode('ResponseMarketDataUpdate', data);
            console.log(`MD Subscribe response - rpCode: ${r.rpCode} msg: ${r.userMsg}`);
        } else if (base.templateId === 150) {
            trades++;
            const lt = decode('LastTrade', data);
            if (trades <= 5) {
                console.log(`Trade: ${lt.symbol} @ ${lt.tradePrice} x${lt.tradeSize} [${lt.exchange}]`);
            }
        } else if (base.templateId === 151) {
            bbos++;
            const bbo = decode('BestBidOffer', data);
            if (bbos <= 5) {
                console.log(`BBO: ${bbo.symbol} bid=${bbo.bidPrice}x${bbo.bidSize} ask=${bbo.askPrice}x${bbo.askSize}`);
            }
        } else if (base.templateId !== 19) {
            console.log(`Unknown templateId: ${base.templateId}`);
        }
    });

    // Listen for 10 seconds
    await new Promise(r => setTimeout(r, 10000));
    console.log(`\n--- 10s Summary ---`);
    console.log(`Total messages: ${msgCount}`);
    console.log(`Trades: ${trades}, BBOs: ${bbos}`);
    console.log(`Connect latency: ${connectMs}ms`);
    console.log(`Login latency: ${loginMs}ms`);

    ws.close();
    process.exit(0);
})();
