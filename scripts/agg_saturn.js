const http = require('http');
const sshExec = (node, cmd) => new Promise((res, rej) => {
  const d = JSON.stringify({ node, command: cmd });
  const r = http.request({
    hostname: 'localhost', port: 3456, path: '/api/ssh/exec',
    method: 'POST', headers: { 'Content-Type': 'application/json' }
  }, resp => {
    let b = ''; resp.on('data', c => b += c); resp.on('end', () => res(JSON.parse(b)));
  });
  r.on('error', rej); r.write(d); r.end();
});

const pyScript = `
import json, glob, os
from collections import defaultdict

base = '/home/saturn/Lvl3Quant/data/processed/oos_wf_fill_sim/saturn_sweep'
configs = defaultdict(lambda: {'pnl': 0, 'trades': 0, 'days': 0})

for f in glob.glob(os.path.join(base, '*.json')):
    try:
        name = '_'.join(os.path.basename(f).split('_')[1:])
        d = json.load(open(f))
        configs[name]['pnl'] += d.get('total_pnl_dollars', 0)
        configs[name]['trades'] += d.get('total_trades', 0)
        configs[name]['days'] += 1
    except:
        pass

ranked = sorted(configs.items(), key=lambda x: x[1]['pnl'], reverse=True)
print('TOP 20 SATURN CONFIGS BY PNL:')
for name, d in ranked[:20]:
    avg = round(d['pnl'] / max(1, d['days']))
    n = name.replace('.json', '')
    print('  ' + n + ': PnL=$' + str(round(d['pnl'])) + ' | ' + str(d['trades']) + ' trades | ' + str(d['days']) + ' days | avg=$' + str(avg) + '/day')

print()
print('BOTTOM 5:')
for name, d in ranked[-5:]:
    avg = round(d['pnl'] / max(1, d['days']))
    n = name.replace('.json', '')
    print('  ' + n + ': PnL=$' + str(round(d['pnl'])) + ' | ' + str(d['trades']) + ' trades | ' + str(d['days']) + ' days | avg=$' + str(avg) + '/day')

print()
print('Total configs: ' + str(len(configs)))
`;

(async () => {
  await sshExec('saturn', "cat > /tmp/agg_saturn.py << 'PYEOF'\n" + pyScript + "\nPYEOF");
  const r = await sshExec('saturn', 'python3 /tmp/agg_saturn.py');
  console.log((r.stdout || '').replace('[saturn]\r\n', ''));
})();
