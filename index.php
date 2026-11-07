<?php
// TripSplit API — PHP + SQLite (no database setup needed)
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out($d, $c = 200) { http_response_code($c); echo json_encode($d); exit; }
function fail($m, $c = 400) { out(['error' => $m], $c); }

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('POST only', 405);
$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) fail('Bad request');
$action = $in['action'] ?? '';

$dir = __DIR__ . '/data';
if (!is_dir($dir)) @mkdir($dir, 0755, true);
try {
  $pdo = new PDO('sqlite:' . $dir . '/tripsplit.sqlite');
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
  $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  $pdo->exec("
  CREATE TABLE IF NOT EXISTS trips(id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, currency TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY, trip_id INTEGER, name TEXT, token TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, trip_id INTEGER, title TEXT, amount INTEGER, category TEXT,
    paid_by INTEGER, date TEXT, note TEXT, personal INTEGER DEFAULT 0, created_by INTEGER, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS splits(expense_id INTEGER, member_id INTEGER, amount INTEGER);
  CREATE TABLE IF NOT EXISTS settlements(id INTEGER PRIMARY KEY, trip_id INTEGER, from_id INTEGER, to_id INTEGER, amount INTEGER, date TEXT, created_at INTEGER);
  CREATE INDEX IF NOT EXISTS ix_m ON members(trip_id); CREATE INDEX IF NOT EXISTS ix_e ON expenses(trip_id);
  CREATE INDEX IF NOT EXISTS ix_s ON splits(expense_id);
  ");
  foreach (["ALTER TABLE members ADD COLUMN gender TEXT DEFAULT ''",
            "ALTER TABLE trips ADD COLUMN egp_rate REAL DEFAULT 1.75",
            "ALTER TABLE expenses ADD COLUMN orig_amount INTEGER DEFAULT 0",
            "ALTER TABLE expenses ADD COLUMN orig_cur TEXT DEFAULT ''",
            "ALTER TABLE expenses ADD COLUMN rate REAL DEFAULT 0",
            "ALTER TABLE expenses ADD COLUMN deleted_at INTEGER DEFAULT 0",
            "ALTER TABLE expenses ADD COLUMN deleted_by INTEGER DEFAULT 0",
            "ALTER TABLE expenses ADD COLUMN split_all INTEGER DEFAULT 0"] as $m) {
    try { $pdo->exec($m); if (strpos($m, 'split_all')) { // one-time: mark old equal-for-everyone expenses
      $pdo->exec("UPDATE expenses SET split_all=1 WHERE personal=0 AND category!='loan'
        AND (SELECT COUNT(*) FROM splits s WHERE s.expense_id=expenses.id)=(SELECT COUNT(*) FROM members m WHERE m.trip_id=expenses.trip_id)
        AND (SELECT MAX(amount)-MIN(amount) FROM splits s WHERE s.expense_id=expenses.id)<=1"); }
    } catch (Exception $e) {} }
} catch (Exception $e) { fail('Database error — check that api/data is writable', 500); }

function q($sql, $p = []) { global $pdo; $s = $pdo->prepare($sql); $s->execute($p); return $s; }
function clean($s, $n = 80) { return mb_substr(trim(strip_tags((string)$s)), 0, $n); }
function newCode() {
  $a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  do { $c = ''; for ($i = 0; $i < 6; $i++) $c .= $a[random_int(0, strlen($a) - 1)]; }
  while (q('SELECT 1 FROM trips WHERE code=?', [$c])->fetch());
  return $c;
}
function getTrip($code) {
  $t = q('SELECT * FROM trips WHERE code=?', [strtoupper(trim((string)$code))])->fetch();
  if (!$t) fail('Trip not found — check the code', 404);
  return $t;
}
function gnd($g) { return in_array($g, ['m', 'f'], true) ? $g : ''; }
function equalSplit($amount, $ids) {
  $n = count($ids); $b = intdiv($amount, $n); $r = $amount - $b * $n; $o = [];
  foreach ($ids as $k => $id) $o[] = ['member_id' => (int)$id, 'amount' => $b + ($k < $r ? 1 : 0)];
  return $o;
}
// A new person joined: every "split between everyone" expense now includes them.
function resplitAll($tid) {
  $ids = array_map('intval', array_column(q('SELECT id FROM members WHERE trip_id=? ORDER BY id', [$tid])->fetchAll(), 'id'));
  if (!$ids) return;
  foreach (q("SELECT id,amount FROM expenses WHERE trip_id=? AND split_all=1 AND personal=0 AND category!='loan'", [$tid])->fetchAll() as $e) {
    q('DELETE FROM splits WHERE expense_id=?', [$e['id']]);
    foreach (equalSplit((int)$e['amount'], $ids) as $s) q('INSERT INTO splits VALUES(?,?,?)', [$e['id'], $s['member_id'], $s['amount']]);
  }
}
// Repair: an expense split equally between everyone who was in the trip when it was added is a
// "split between everyone" expense, even if it was saved by an older app version. Mark it and include later joiners.
function repairSplitAll($tid) {
  $mem = q('SELECT id,created_at FROM members WHERE trip_id=? ORDER BY id', [$tid])->fetchAll(); $changed = false;
  $cand = q("SELECT id,amount,created_at FROM expenses WHERE trip_id=? AND split_all=0 AND personal=0 AND category!='loan'", [$tid])->fetchAll();
  foreach ($cand as $e) {
    $then = array_values(array_map(fn($m) => (int)$m['id'], array_filter($mem, fn($m) => (int)$m['created_at'] <= (int)$e['created_at'])));
    if (!$then) continue;
    $sp = q('SELECT member_id,amount FROM splits WHERE expense_id=?', [$e['id']])->fetchAll();
    $ids = array_map(fn($s) => (int)$s['member_id'], $sp); sort($ids); $t2 = $then; sort($t2);
    $am = array_map(fn($s) => (int)$s['amount'], $sp);
    if ($ids === $t2 && $am && max($am) - min($am) <= 1) { q('UPDATE expenses SET split_all=1 WHERE id=?', [$e['id']]); $changed = true; }
  }
  if ($changed) resplitAll($tid);
}
function addMember($tripId, $name, $gender = '') {
  $tok = bin2hex(random_bytes(16));
  q('INSERT INTO members(trip_id,name,token,created_at,gender) VALUES(?,?,?,?,?)', [$tripId, $name, $tok, time(), gnd($gender)]);
  global $pdo; $id = (int)$pdo->lastInsertId(); resplitAll($tripId); return [$id, $tok];
}
function auth($in) {
  $t = getTrip($in['code'] ?? '');
  $m = q('SELECT * FROM members WHERE trip_id=? AND token=?', [$t['id'], (string)($in['token'] ?? '')])->fetch();
  if (!$m) fail('Not signed in to this trip', 401);
  return [$t, $m];
}
function publicMembers($tid) {
  return array_map(fn($r) => ['id' => (int)$r['id'], 'name' => $r['name'], 'gender' => $r['gender'] ?? ''],
    q('SELECT id,name,gender FROM members WHERE trip_id=? ORDER BY id', [$tid])->fetchAll());
}

switch ($action) {
  case 'create_trip':
    $name = clean($in['name'] ?? ''); $who = clean($in['your_name'] ?? '', 40);
    $cur = 'INR';
    if ($name === '' || $who === '') fail('Trip name and your name are required');
    $code = newCode();
    q('INSERT INTO trips(code,name,currency,created_at) VALUES(?,?,?,?)', [$code, $name, $cur, time()]);
    $tid = (int)$pdo->lastInsertId();
    [$mid, $tok] = addMember($tid, $who, $in['gender'] ?? '');
    out(['code' => $code, 'member_id' => $mid, 'token' => $tok, 'name' => $name]);

  case 'trip_info':
    $t = getTrip($in['code'] ?? '');
    out(['name' => $t['name'], 'code' => $t['code'], 'currency' => $t['currency'], 'members' => publicMembers($t['id'])]);

  case 'join':
    $t = getTrip($in['code'] ?? ''); $who = clean($in['name'] ?? '', 40);
    if ($who === '') fail('Please type your name');
    [$mid, $tok] = addMember($t['id'], $who, $in['gender'] ?? '');
    out(['code' => $t['code'], 'member_id' => $mid, 'token' => $tok, 'name' => $t['name']]);

  case 'claim': // "I'm already in this trip" (new phone / reinstalled)
    $t = getTrip($in['code'] ?? '');
    $m = q('SELECT * FROM members WHERE trip_id=? AND id=?', [$t['id'], (int)($in['member_id'] ?? 0)])->fetch();
    if (!$m) fail('Person not found');
    out(['code' => $t['code'], 'member_id' => (int)$m['id'], 'token' => $m['token'], 'name' => $t['name']]);

  case 'state':
    [$t, $me] = auth($in);
    repairSplitAll($t['id']);
    $sp = q('SELECT s.* FROM splits s JOIN expenses e ON e.id=s.expense_id WHERE e.trip_id=?', [$t['id']])->fetchAll();
    $by = [];
    foreach ($sp as $s) $by[$s['expense_id']][] = ['member_id' => (int)$s['member_id'], 'amount' => (int)$s['amount']];
    $fmt = function ($rows) use ($by) {
      foreach ($rows as &$e) {
        foreach (['id', 'amount', 'paid_by', 'split_all', 'orig_amount', 'personal', 'created_by', 'deleted_at', 'deleted_by'] as $k) $e[$k] = (int)$e[$k];
        $e['rate'] = (float)$e['rate']; $e['splits'] = $by[$e['id']] ?? []; unset($e['trip_id']);
      }
      return $rows;
    };
    $ex = $fmt(q('SELECT * FROM expenses WHERE trip_id=? AND deleted_at=0 AND (personal=0 OR created_by=?) ORDER BY date DESC, id DESC', [$t['id'], $me['id']])->fetchAll());
    $del = $fmt(q('SELECT * FROM expenses WHERE trip_id=? AND deleted_at>0 AND (personal=0 OR created_by=?) ORDER BY deleted_at DESC', [$t['id'], $me['id']])->fetchAll());
    $st = q('SELECT id,from_id,to_id,amount,date FROM settlements WHERE trip_id=? ORDER BY id DESC', [$t['id']])->fetchAll();
    foreach ($st as &$s) { foreach (['id', 'from_id', 'to_id', 'amount'] as $k) $s[$k] = (int)$s[$k]; }
    out(['trip' => ['name' => $t['name'], 'code' => $t['code'], 'currency' => 'INR', 'egp_rate' => (float)($t['egp_rate'] ?: 1.75)], 'me' => (int)$me['id'],
         'members' => publicMembers($t['id']), 'expenses' => $ex, 'deleted' => $del, 'settlements' => $st]);

  case 'set_rate': // group-decided Egyptian pound → rupee rate
    [$t, $me] = auth($in);
    $r = round((float)($in['rate'] ?? 0), 4);
    if ($r <= 0 || $r > 1000) fail('Enter a valid rate');
    q('UPDATE trips SET egp_rate=? WHERE id=?', [$r, $t['id']]); out(['ok' => true]);

  case 'delete_trip': // only the person who created the trip (first member) can delete it for everyone
    [$t, $me] = auth($in);
    $creator = (int)q('SELECT MIN(id) FROM members WHERE trip_id=?', [$t['id']])->fetchColumn();
    if ((int)$me['id'] !== $creator) fail('Only the person who created this trip can delete it', 403);
    $pdo->beginTransaction();
    q('DELETE FROM splits WHERE expense_id IN (SELECT id FROM expenses WHERE trip_id=?)', [$t['id']]);
    q('DELETE FROM expenses WHERE trip_id=?', [$t['id']]);
    q('DELETE FROM settlements WHERE trip_id=?', [$t['id']]);
    q('DELETE FROM members WHERE trip_id=?', [$t['id']]);
    q('DELETE FROM trips WHERE id=?', [$t['id']]);
    $pdo->commit(); out(['ok' => true]);

  case 'add_member': // add a friend who doesn't have the app yet
    [$t, $me] = auth($in);
    $who = clean($in['name'] ?? '', 40); if ($who === '') fail('Name required');
    addMember($t['id'], $who, $in['gender'] ?? ''); out(['ok' => true]);

  case 'rename_member':
    [$t, $me] = auth($in);
    $who = clean($in['name'] ?? '', 40); if ($who === '') fail('Name required');
    q('UPDATE members SET name=? WHERE id=? AND trip_id=?', [$who, (int)($in['member_id'] ?? 0), $t['id']]); out(['ok' => true]);

  case 'save_expense':
    [$t, $me] = auth($in);
    $x = $in['expense'] ?? [];
    $title = clean($x['title'] ?? '', 80); $amt = (int)($x['amount'] ?? 0);
    if ($title === '' || $amt <= 0) fail('Add a title and an amount');
    $personal = !empty($x['personal']) ? 1 : 0;
    $ids = array_map('intval', array_column(q('SELECT id FROM members WHERE trip_id=?', [$t['id']])->fetchAll(), 'id'));
    $paid = $personal ? (int)$me['id'] : (int)($x['paid_by'] ?? 0);
    if (!in_array($paid, $ids, true)) fail('Pick who paid');
    $splits = $personal ? [['member_id' => (int)$me['id'], 'amount' => $amt]] : ($x['splits'] ?? []);
    $cat0 = clean($x['category'] ?? 'other', 20) ?: 'other';
    $sa = (!empty($x['split_all']) && !$personal && $cat0 !== 'loan') ? 1 : 0;
    if (!$sa && !$personal && $cat0 !== 'loan' && $splits) { // equal split between everyone ⇒ treat as "everyone" even if the app didn't say so
      $sid = array_map(fn($s) => (int)$s['member_id'], $splits); sort($sid); $all = $ids; sort($all);
      $am = array_map(fn($s) => (int)$s['amount'], $splits);
      if ($sid === $all && max($am) - min($am) <= 1) $sa = 1;
    }
    if ($sa) $splits = equalSplit($amt, $ids);
    $sum = 0; foreach ($splits as $s) {
      if (!in_array((int)$s['member_id'], $ids, true) || (int)$s['amount'] < 0) fail('Bad split');
      $sum += (int)$s['amount'];
    }
    if (!$splits || $sum !== $amt) fail('Split must add up to the total');
    $cat = clean($x['category'] ?? 'other', 20) ?: 'other';
    $date = preg_match('/^\d{4}-\d{2}-\d{2}$/', $x['date'] ?? '') ? $x['date'] : date('Y-m-d');
    $note = clean($x['note'] ?? '', 300);
    $oc = ($x['orig_cur'] ?? '') === 'EGP' ? 'EGP' : '';
    $oa = $oc ? max(0, (int)($x['orig_amount'] ?? 0)) : 0; $rt = $oc ? max(0, (float)($x['rate'] ?? 0)) : 0;
    $pdo->beginTransaction();
    $id = (int)($x['id'] ?? 0);
    if ($id) {
      $old = q('SELECT * FROM expenses WHERE id=? AND trip_id=?', [$id, $t['id']])->fetch();
      if (!$old) { $pdo->rollBack(); fail('Expense not found', 404); }
      if ($old['personal'] && (int)$old['created_by'] !== (int)$me['id']) { $pdo->rollBack(); fail('Private expense', 403); }
      q('UPDATE expenses SET title=?,amount=?,category=?,paid_by=?,date=?,note=?,personal=?,orig_amount=?,orig_cur=?,rate=?,split_all=? WHERE id=?', [$title, $amt, $cat, $paid, $date, $note, $personal, $oa, $oc, $rt, $sa, $id]);
      q('DELETE FROM splits WHERE expense_id=?', [$id]);
    } else {
      q('INSERT INTO expenses(trip_id,title,amount,category,paid_by,date,note,personal,created_by,created_at,orig_amount,orig_cur,rate,split_all) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [$t['id'], $title, $amt, $cat, $paid, $date, $note, $personal, $me['id'], time(), $oa, $oc, $rt, $sa]);
      $id = (int)$pdo->lastInsertId();
    }
    foreach ($splits as $s) q('INSERT INTO splits VALUES(?,?,?)', [$id, (int)$s['member_id'], (int)$s['amount']]);
    $pdo->commit(); out(['ok' => true, 'id' => $id]);

  case 'delete_expense':
    [$t, $me] = auth($in);
    $id = (int)($in['id'] ?? 0);
    $old = q('SELECT * FROM expenses WHERE id=? AND trip_id=?', [$id, $t['id']])->fetch();
    if (!$old) fail('Not found', 404);
    if ($old['personal'] && (int)$old['created_by'] !== (int)$me['id']) fail('Private expense', 403);
    q('UPDATE expenses SET deleted_at=?, deleted_by=? WHERE id=?', [time(), $me['id'], $id]); out(['ok' => true]); // soft delete → "Deleted" section

  case 'restore_expense':
    [$t, $me] = auth($in);
    $old = q('SELECT * FROM expenses WHERE id=? AND trip_id=?', [(int)($in['id'] ?? 0), $t['id']])->fetch();
    if (!$old) fail('Not found', 404);
    if ($old['personal'] && (int)$old['created_by'] !== (int)$me['id']) fail('Private expense', 403);
    q('UPDATE expenses SET deleted_at=0, deleted_by=0 WHERE id=?', [$old['id']]); out(['ok' => true]);

  case 'purge_expense': // delete forever (only from the Deleted section)
    [$t, $me] = auth($in);
    $old = q('SELECT * FROM expenses WHERE id=? AND trip_id=? AND deleted_at>0', [(int)($in['id'] ?? 0), $t['id']])->fetch();
    if (!$old) fail('Not found', 404);
    if ($old['personal'] && (int)$old['created_by'] !== (int)$me['id']) fail('Private expense', 403);
    q('DELETE FROM splits WHERE expense_id=?', [$old['id']]); q('DELETE FROM expenses WHERE id=?', [$old['id']]); out(['ok' => true]);

  case 'add_settlement':
    [$t, $me] = auth($in);
    $f = (int)($in['from_id'] ?? 0); $to = (int)($in['to_id'] ?? 0); $a = (int)($in['amount'] ?? 0);
    if ($a <= 0 || $f === $to) fail('Bad settlement');
    q('INSERT INTO settlements(trip_id,from_id,to_id,amount,date,created_at) VALUES(?,?,?,?,?,?)', [$t['id'], $f, $to, $a, date('Y-m-d'), time()]);
    out(['ok' => true]);

  case 'delete_settlement':
    [$t, $me] = auth($in);
    q('DELETE FROM settlements WHERE id=? AND trip_id=?', [(int)($in['id'] ?? 0), $t['id']]); out(['ok' => true]);

  default: fail('Unknown action');
}
