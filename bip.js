// Ball In Play scorer (cricket rules): an event log -> every field the bug shows.
// Used by control.html; the log lives at gfx/<tournament>/scorer/log so Undo is just "drop the last event".
// Events: {k:'ball', t}  t = 0 dot | 1-6 runs | w wicket | w1-w3 runs + wicket (shown 1W-3W) | wd wide | wd1-wd6 wide + runs
//         {k:'bat', slot: 0|1, name}  {k:'bowl', name}  {k:'swap'}  {k:'innings'}
// Rules (Chris, 2026-10-09): an innings ends after 4 overs or 3 wickets · wide = 1 run, wide+N = 1+N, to team + bowler, not a ball ·
// a wicket is a good ball · strike swaps on odd runs (incl. runs on a wide) and at the end of every over.
const BIP = {
  OVERS: 4,
  WICKETS: 3,
  legal: (t) => !String(t).startsWith('wd'),
  wicket: (t) => /^w\d?$/.test(String(t)), // w, or w1-w3: runs taken on the ball, then a wicket
  runs: (t) => (t === 'w' || t === '0' ? 0 : String(t).startsWith('wd') ? 1 + (+String(t).slice(2) || 0) : /^w\d$/.test(t) ? +String(t).slice(1) : +t),
  // The over's circles: empty circles = good balls left in the over, always. 6 circles, +1 per wide up to 8;
  // when the deliveries don't fit (e.g. a 3rd wide), the oldest drops off the left so the empties stay right.
  // over = "0,1,wd,wd2,w" (this over, oldest first) -> { count, shown: deliveries in circles 1..n }
  circles(over) {
    const balls = String(over || '').split(',').map(b => b.trim().toLowerCase()).filter(Boolean);
    const left = Math.max(0, 6 - balls.filter(BIP.legal).length);
    const count = Math.min(8, balls.length + left);
    return { count, shown: balls.slice(balls.length - Math.max(0, count - left)) };
  },
  ov: (balls) => `${Math.floor(balls / 6)}.${balls % 6}`, // cricket notation: 9 legal balls = "1.3"

  derive(log, firstTeam = '', secondTeam = '') {
    const teamRuns = [0, 0]; // [batted first, batted second] across all innings
    let inn = 0, I;
    const newInnings = () => {
      inn++;
      // batter stats belong to the slot (crease position), not the name: blank or duplicate names can't merge
      I = { runs: 0, wkts: 0, legal: 0, bat: ['', ''], stats: [{ r: 0, b: 0 }, { r: 0, b: 0 }], strike: 0, bowler: '', bowlers: {},
            over: [], overDone: false, needBatter: null };
    };
    newInnings();
    for (const e of log || []) {
      if (e.k === 'innings') newInnings();
      else if (e.k === 'bat') {
        I.bat[e.slot] = e.name;
        if (I.needBatter === e.slot) { I.stats[e.slot] = { r: 0, b: 0 }; I.needBatter = null; } // new batter; else a name fix
      }
      else if (e.k === 'bowl') {
        // the circles are this bowler's deliveries: a different bowler starts them fresh (same name = no change)
        if (e.name !== I.bowler) { I.over = []; I.overDone = false; }
        I.bowler = e.name;
      }
      else if (e.k === 'swap') I.strike ^= 1;
      else if (e.k === 'ball') {
        const t = String(e.t), legal = BIP.legal(t), r = BIP.runs(t);
        if (I.overDone) { I.over = []; I.overDone = false; } // first ball of the next over
        I.over.push(t);
        const bat = I.stats[I.strike];
        const bowl = (I.bowlers[I.bowler] ||= { r: 0, w: 0, x: 0, legal: 0 });
        I.runs += r; teamRuns[(inn - 1) % 2] += r; bowl.r += r;
        if (legal) { bat.b++; bowl.legal++; I.legal++; bat.r += r; } else bowl.x++;
        if (BIP.wicket(t)) { I.wkts++; bowl.w++; I.needBatter = I.strike; } // the batter who faced it is out; new batter takes their end
        if ((legal ? r : r - 1) % 2) I.strike ^= 1; // odd runs actually run
        if (legal && I.over.filter(BIP.legal).length === 6) { I.overDone = true; I.strike ^= 1; }
      }
    }
    const firstBats = inn % 2 === 1;
    const [mine, theirs] = firstBats ? teamRuns : [teamRuns[1], teamRuns[0]];
    const batting = firstBats ? firstTeam : secondTeam, bowling = firstBats ? secondTeam : firstTeam;
    const s = I.bat[I.strike], ns = I.bat[I.strike ^ 1], st = I.stats[I.strike], nst = I.stats[I.strike ^ 1];
    const bw = I.bowlers[I.bowler] || { r: 0, w: 0, x: 0, legal: 0 };
    const left = BIP.OVERS * 6 - I.legal;
    const inningsDone = left <= 0 || I.wkts >= BIP.WICKETS;
    return {
      values: {
        over: I.over.join(','), // stays up after the 6th good ball until the next over starts; display.html turns this into the circles
        overs: BIP.ov(I.legal), inning: inn, outs: I.wkts,
        firstScore: teamRuns[0], secondScore: teamRuns[1], battingTeam: batting, bowlingTeam: bowling,
        striker: s, strikerRuns: st.r, strikerBalls: st.b,
        nonStriker: ns, nonStrikerRuns: nst.r, nonStrikerBalls: nst.b,
        bowler: I.bowler, bowlerOvers: BIP.ov(bw.legal),
        bowlerFigures: `${bw.r}r-${bw.w}w ${bw.x}x`, // runs given up - wickets taken, wides bowled
        // Chase line once the second team has batted at all: shown while they trail with balls left.
        situation: inn >= 2 && mine <= theirs && !inningsDone ? `${batting} need ${theirs - mine + 1} off ${left}` : '',
      },
      overDone: I.overDone, inningsDone, needBatter: inningsDone ? null : I.needBatter, bat: I.bat, bowler: I.bowler,
    };
  },
};

// Self-check: node bip.js
if (typeof module !== 'undefined' && require.main === module) {
  const assert = require('assert');
  const ball = (t) => ({ k: 'ball', t });
  const log = [
    { k: 'bat', slot: 0, name: 'Jimmy' }, { k: 'bat', slot: 1, name: 'Franky' }, { k: 'bowl', name: 'BBD' },
    ball('1'), ball('4'), ball('wd'), ball('wd1'), ball('0'), ball('w'), { k: 'bat', slot: 0, name: 'Shelfy' },
    ball('2'), ball('6'),
  ];
  let d = BIP.derive(log, 'Woogas', 'Baggage');
  // Jimmy 1 (swap) · Franky 4 · wide · wide+1 ran 1 (swap) · Jimmy dot · Jimmy out · Shelfy 2, 6 · over ends (swap)
  assert.equal(d.values.over, '1,4,wd,wd1,0,w,2,6');
  assert.deepEqual([d.values.firstScore, d.values.outs, d.values.overs], [16, 1, '1.0']);
  assert.equal(d.values.bowlerFigures, '16r-1w 2x');
  assert.deepEqual([d.values.striker, d.values.strikerRuns, d.values.strikerBalls], ['Franky', 4, 1]);
  assert.deepEqual([d.values.nonStriker, d.values.nonStrikerRuns, d.values.nonStrikerBalls], ['Shelfy', 8, 2]);
  assert.equal(d.overDone, true); assert.equal(d.values.situation, '');
  assert.deepEqual([d.values.battingTeam, d.values.bowlingTeam], ['Woogas', 'Baggage']);
  log.push(ball('3')); // next ball starts a fresh over
  assert.equal(BIP.derive(log).values.over, '3');
  log.push({ k: 'innings' }, { k: 'bat', slot: 0, name: 'A' }, { k: 'bat', slot: 1, name: 'B' }, { k: 'bowl', name: 'Trevor' }, ball('wd2'));
  d = BIP.derive(log, 'Woogas', 'Baggage');
  assert.deepEqual([d.values.battingTeam, d.values.firstScore, d.values.secondScore], ['Baggage', 19, 3]);
  assert.equal(d.values.situation, 'Baggage need 17 off 24'); // wide+2 = 3 runs, not a ball
  assert.equal(d.values.striker, 'A', 'ran 2 on the wide: no swap');
  // a new bowler clears the circles; re-picking the same bowler doesn't
  const nb = [{ k: 'bowl', name: 'BBD' }, ball('4'), ball('wd'), { k: 'bowl', name: 'BBD' }];
  assert.equal(BIP.derive(nb).values.over, '4,wd');
  assert.equal(BIP.derive([...nb, { k: 'bowl', name: 'Trevor' }]).values.over, '');
  assert.equal(BIP.derive([...nb, { k: 'bowl', name: 'Trevor' }, ball('1')]).values.over, '1');
  // stats follow the batter, never the name: unnamed batters, a 6 then a single
  d = BIP.derive([ball('6')]);
  assert.deepEqual([d.values.strikerRuns, d.values.strikerBalls, d.values.nonStrikerRuns, d.values.nonStrikerBalls], [6, 1, 0, 0]);
  d = BIP.derive([ball('6'), ball('1')]); // single: strike swaps, the 7-off-2 batter moves to the bottom row
  assert.deepEqual([d.values.strikerRuns, d.values.strikerBalls, d.values.nonStrikerRuns, d.values.nonStrikerBalls], [0, 0, 7, 2]);
  d = BIP.derive([{ k: 'bat', slot: 0, name: 'Jimy' }, ball('4'), { k: 'bat', slot: 0, name: 'Jimmy' }]); // typo fix keeps stats
  assert.deepEqual([d.values.striker, d.values.strikerRuns], ['Jimmy', 4]);
  // 3 wickets end the innings: no new-batter prompt, no chase line
  const w3 = [...log, ball('w'), { k: 'bat', slot: 0, name: 'C' }, ball('w'), { k: 'bat', slot: 0, name: 'D' }, ball('w')];
  d = BIP.derive(w3, 'Woogas', 'Baggage');
  assert.deepEqual([d.values.outs, d.inningsDone, d.needBatter, d.values.situation], [3, true, null, '']);
  // 1W-3W (Chris 2026-10-13): runs to batter/team/bowler, a good ball, a wicket for the bowler, the batter who faced is out
  d = BIP.derive([{ k: 'bat', slot: 0, name: 'A' }, { k: 'bat', slot: 1, name: 'B' }, { k: 'bowl', name: 'C' }, ball('2'), ball('w1')]);
  assert.deepEqual([d.values.firstScore, d.values.outs, d.values.overs, d.values.bowlerFigures], [3, 1, '0.2', '3r-1w 0x']);
  assert.equal(d.needBatter, 0, 'A faced the 1W: A is out');
  assert.deepEqual([d.values.striker, d.values.strikerRuns], ['B', 0], 'odd run: strike swapped to B');
  assert.equal(BIP.circles('2,w1').shown.join(','), '2,w1');
  // circles: empties always = good balls left (Chris 2026-10-12)
  const c = o => { const r = BIP.circles(o); return [r.count, r.shown.join(',')]; };
  assert.deepEqual(c(''), [6, '']);
  assert.deepEqual(c('1,wd'), [7, '1,wd']);                    // a wide adds a circle
  assert.deepEqual(c('wd,wd,wd'), [8, 'wd,wd']);               // 3rd wide: 6 good balls still to come -> 6 empties, oldest wide off the left
  assert.deepEqual(c('1,wd,2,wd,wd'), [8, 'wd,2,wd,wd']);      // 4 good balls left -> 4 empties, 4 deliveries shown, the 1 drops off
  assert.deepEqual(c('wd,1,2,wd,3,wd,4,5,6'), [8, '1,2,wd,3,wd,4,5,6']);  // over done on its 6th good ball: latest 8
  // An over ends on its 6th good ball, never on a wide (a wide after it starts the next over), so the 8th circle
  // is never a wide. Every possible over with up to 4 wides, checked at every ball as the scorer builds it:
  const overs = [];
  const grow = (seq, legal, wides) => {
    if (legal === 6) return overs.push(seq);
    grow([...seq, '1'], legal + 1, wides);
    if (wides < 4) grow([...seq, 'wd'], legal, wides + 1);
  };
  grow([], 0, 0);
  for (const seq of overs) {
    const log = seq.map(ball);
    for (let k = 1; k <= log.length; k++) {
      const { count, shown } = BIP.circles(BIP.derive(log.slice(0, k)).values.over);
      if (count === 8 && shown.length === 8) assert.ok(BIP.legal(shown[7]), `8th circle a wide: ${seq.slice(0, k)}`);
    }
    assert.equal(BIP.derive([...log, ball('wd')]).values.over, 'wd', 'a wide after the 6th good ball starts the next over');
  }
  assert.deepEqual(c('0,w,wd'), [7, '0,w,wd']);                // a wicket is a good ball
  console.log('bip.js: all checks passed');
}
