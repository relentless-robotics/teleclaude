const protobuf = require('protobufjs');
const WebSocket = require('ws');

const root = new protobuf.Root();
// Load all needed protos from parent dir too
const protoDir = '../../proto/';
root.loadSync('base.proto');
root.loadSync('request_login.proto');
root.loadSync('response_login.proto');
root.loadSync('request_heartbeat.proto');
root.loadSync('response_heartbeat.proto');
root.loadSync('request_market_data_update.proto');
root.loadSync('response_market_data_update.proto');
root.loadSync('last_trade.proto');
root.loadSync('best_bid_offer.proto');
// MBO-specific
root.loadSync(protoDir + 'request_depth_by_order_updates.proto');
root.loadSync(protoDir + 'depth_by_order.proto');
root.loadSync(protoDir + 'depth_by_order_end_event.proto');
root.loadSync(protoDir + 'request_depth_by_order_snapshot.proto');
root.loadSync(protoDir + 'response_depth_by_order_snapshot.proto');

function encode(typeName, obj) {
    const T = root.lookupType(typeName);
    return Buffer.from(T.encode(T.create(obj)).finish());
}
function decode(typeName, buf) {
    return root.lookupType(typeName).decode(buf);
}

(async () => {
    const ws = new WebSocket('wss://rituz00100.rithmic.com:443', { rejectUnauthorized: false });
    await new Promise(r => ws.on('open', r));
    console.log('Connected');

    // Login as TICKER_PLANT
    const RequestLogin = root.lookupType('RequestLogin');
    ws.send(encode('RequestLogin', {
        templateId: 10, templateVersion: '3.9', userMsg: ['mbo_test'],
        user: 'njliautaud@gmail.com', password: 'MA8KTPiV',
        appName: 'TeleClaude', appVersion: '1.0.0',
        systemName: 'Rithmic Test', infraType: RequestLogin.SysInfraType.TICKER_PLANT
    }));
    let resp = await new Promise(r => ws.once('message', r));
    const login = decode('ResponseLogin', resp);
    console.log('Login rpCode:', login.rpCode[0]);

    if (login.rpCode[0] !== '0') {
        console.log('Login failed');
        process.exit(1);
    }

    // Subscribe to depth-by-order (MBO) for ES
    const RequestDBO = root.lookupType('RequestDepthByOrderUpdates');
    ws.send(encode('RequestDepthByOrderUpdates', {
        templateId: 312,
        userMsg: ['mbo_sub'],
        symbol: 'ESM6',
        exchange: 'CME',
        request: RequestDBO.Request.SUBSCRIBE
    }));

    // Also subscribe to regular market data for comparison
    const RequestMD = root.lookupType('RequestMarketDataUpdate');
    ws.send(encode('RequestMarketDataUpdate', {
        templateId: 100, userMsg: ['md_sub'], symbol: 'ESM6', exchange: 'CME',
        request: RequestMD.Request.SUBSCRIBE,
        updateBits: RequestMD.UpdateBits.LAST_TRADE | RequestMD.UpdateBits.BBO
    }));

    let msgCount = 0;
    let dboCount = 0;
    let tradeCount = 0;
    let bboCount = 0;
    let otherCount = 0;

    ws.on('message', (data) => {
        const base = decode('Base', data);
        msgCount++;

        if (base.templateId === 318) {
            // DepthByOrder update
            dboCount++;
            const dbo = decode('DepthByOrder', data);
            if (dboCount <= 10) {
                const types = (dbo.updateType || []).map(t => ['?','NEW','CHG','DEL'][t] || t);
                const sides = (dbo.transactionType || []).map(s => s === 1 ? 'BUY' : 'SELL');
                console.log(`MBO: ${types.join(',')} ${sides.join(',')} price=${dbo.depthPrice} size=${dbo.depthSize} prio=${dbo.depthOrderPriority} seq=${dbo.sequenceNumber}`);
            }
        } else if (base.templateId === 150) {
            tradeCount++;
        } else if (base.templateId === 151) {
            bboCount++;
        } else if (base.templateId === 101) {
            const r = decode('ResponseMarketDataUpdate', data);
            console.log('MD response:', r.rpCode, r.userMsg);
        } else if (base.templateId === 19) {
            // heartbeat
        } else {
            otherCount++;
            if (otherCount <= 5) {
                console.log('templateId:', base.templateId);
            }
        }
    });

    // Listen for 10 seconds
    await new Promise(r => setTimeout(r, 10000));
    console.log('\n--- 10s MBO Summary ---');
    console.log(`Total messages: ${msgCount}`);
    console.log(`MBO (depth-by-order): ${dboCount}`);
    console.log(`Trades: ${tradeCount}`);
    console.log(`BBOs: ${bboCount}`);
    console.log(`Other: ${otherCount}`);
    console.log(`MBO rate: ${(dboCount/10).toFixed(1)} msgs/sec`);

    ws.close();
    process.exit(0);
})();
