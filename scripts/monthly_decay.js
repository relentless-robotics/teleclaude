const http = require('http');

function sshExec(cmd) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ node: 'jupiter', command: cmd });
    const req = http.request({
      hostname: 'localhost', port: 3456, path: '/api/ssh/exec',
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  await new Promise(r => setTimeout(r, 2000));

  const pyScript = [
    'import json, glob, os',
    'from collections import defaultdict',
    '',
    'for config in ["tp15_h2h", "tp13_prime_chase"]:',
    '    monthly = {}',
    '    pattern = "/home/jupiter/Lvl3Quant/data/processed/oos_wf_fill_sim/*_oos_" + config + ".json"',
    '    for f in sorted(glob.glob(pattern)):',
    '        m = os.path.basename(f)[:7]',
    '        d = json.load(open(f))',
    '        if m not in monthly: monthly[m] = {"pnl":0,"trades":0,"wins":0,"days":0}',
    '        monthly[m]["pnl"] += d.get("total_pnl_dollars", 0)',
    '        monthly[m]["trades"] += d.get("total_trades", 0)',
    '        monthly[m]["wins"] += d.get("wins", 0)',
    '        monthly[m]["days"] += 1',
    '    print("=== " + config + " ===")',
    '    for m in sorted(monthly):',
    '        d = monthly[m]',
    '        wr = round(100 * d["wins"] / max(1, d["trades"]), 1)',
    '        avg = round(d["pnl"] / max(1, d["days"]), 0)',
    '        print(m + ": PnL=$" + str(round(d["pnl"])) + " | " + str(d["trades"]) + " trades | " + str(wr) + "% WR | " + str(d["days"]) + " days | avg/day=$" + str(avg))',
    '    print()',
  ].join('\n');

  const r = await sshExec(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`);
  console.log(r.stdout || r.stderr || JSON.stringify(r));
})();
