// balance.js
// Shared obfuscated balance storage for browser (localStorage) with tamper detection.
// Exported functions: initBalance(), getBalance(), setBalance(amount),
//                     saveBalance(amount), verifyIntegrity(), subscribe(cb)
// New: startHashRoller(), stopHashRoller()

const BALANCE_KEY = "balanceData_v1";
const HASH_KEY = "balanceHash_v1";

// compute SHA-256 hex digest of a string
async function computeHashHex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// produce base64 of random bytes of given length
function randomBase64(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  // convert bytes to binary string then base64
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

// Build the obfuscated stored string for a numeric amount (does not set storage)
function buildObfuscatedForAmount(amount) {
  const encoded = btoa(String(amount)); // base64 numeric
  const prefix = randomBase64(128); // random noise
  const suffix = randomBase64(128);
  return prefix + encoded + suffix;
}

// Save obfuscated balance and its hash to localStorage
export async function saveBalance(amount) {
  const stored = buildObfuscatedForAmount(amount);
  const hash = await computeHashHex(stored);
  // Write stored value and its hash (overwrites previous ones — "forgets" previous)
  localStorage.setItem(BALANCE_KEY, stored);
  localStorage.setItem(HASH_KEY, hash);
  notifySubscribers(amount);
}

// Verify integrity: stored string exists and matches stored hash
export async function verifyIntegrity() {
  const stored = localStorage.getItem(BALANCE_KEY);
  const storedHash = localStorage.getItem(HASH_KEY);
  if (!stored || !storedHash) return false;
  try {
    const currentHash = await computeHashHex(stored);
    return currentHash === storedHash;
  } catch {
    return false;
  }
}

// Attempt to extract the numeric value by scanning for valid base64-decoded number substrings.
function extractNumberFromObfuscated(content) {
  // Bruteforce scan substrings and try atob; pick last valid numeric decode.
  let last = null;
  for (let i = 0; i < content.length; i++) {
    // j must be at least i+2 or more; base64 minimal length is small; try up to +60 for performance
    for (let j = i + 4; j <= Math.min(content.length, i + 60); j++) {
      const sub = content.slice(i, j);
      try {
        // atob may throw
        const dec = atob(sub);
        if (/^\d+$/.test(dec)) last = parseInt(dec, 10);
      } catch (e) {
        // ignore
      }
    }
  }
  return last;
}

let _balance = 0;
let subscribers = new Set();

// Notify subscribed callbacks of balance change
function notifySubscribers(balance) {
  subscribers.forEach(cb => {
    try { cb(balance); } catch (e) { /* ignore */ }
  });
}

// Initialize balance: if missing or tampered, reset to 0 (per request)
let hashRollerTimer = null;
export async function initBalance({ defaultBalance = 100, autoRegen = true } = {}) {
  const ok = await verifyIntegrity();
  if (!ok) {
    // If tampered or missing, set to zero (user requested this behavior)
    _balance = 0;
    await saveBalance(_balance);
    if (autoRegen) {
      startAutoRegen();
      startHashRoller();
    }
    return _balance;
  }

  const stored = localStorage.getItem(BALANCE_KEY);
  const extracted = extractNumberFromObfuscated(stored);
  if (extracted === null) {
    _balance = defaultBalance;
    await saveBalance(_balance);
  } else {
    _balance = extracted;
  }
  if (autoRegen) {
    startAutoRegen();
    startHashRoller();
  }
  return _balance;
}

// returns current in-memory balance
export function getBalance() {
  return _balance;
}

// set new balance and persist
export async function setBalance(amount) {
  _balance = Math.max(0, Math.floor(Number(amount) || 0));
  await saveBalance(_balance);
  return _balance;
}

// Simple auto-regeneration: if balance below threshold, increment every interval
let regenTimer = null;
export function startAutoRegen({ threshold = 100, intervalMs = 10000 } = {}) {
  if (regenTimer) return;
  regenTimer = setInterval(async () => {
    if (_balance < threshold) {
      _balance += 1;
      await saveBalance(_balance);
    }
  }, intervalMs);
}
export function stopAutoRegen() {
  if (regenTimer) { clearInterval(regenTimer); regenTimer = null; }
}

// subscribe(cb): cb receives (newBalance). returns unsubscribe() function
export function subscribe(cb) {
  subscribers.add(cb);
  // call immediately with current balance
  try { cb(_balance); } catch {}
  return () => { subscribers.delete(cb); };
}

// convenience: attempt to repair if tampered by resetting to default (default 0 to match tamper behavior)
export async function repairReset(defaultBalance = 0) {
  _balance = defaultBalance;
  await saveBalance(_balance);
  return _balance;
}

/* -------------------------
   Hash-roller: overwrites the stored obfuscated string and its hash every 500ms
   by regenerating random prefix/suffix around the current numeric encoding.
   This ensures the hash value changes repeatedly and the previous hash is overwritten.
   ------------------------- */

export function startHashRoller({ intervalMs = 5 } = {}) {
  // if already running, do nothing
  if (hashRollerTimer) return;
  // create a timer that rebuilds the obfuscated stored string (same numeric amount) and writes new hash
  hashRollerTimer = setInterval(async () => {
    try {
      // read current stored numeric amount from memory (not from localStorage to avoid race)
      // but if _balance is unknown, try to extract from storage as fallback
      let amount = _balance;
      if (typeof amount !== "number") {
        const stored = localStorage.getItem(BALANCE_KEY);
        amount = extractNumberFromObfuscated(stored) ?? 0;
      }
      // Build new stored string with fresh random noise but same encoded numeric
      const newStored = buildObfuscatedForAmount(amount);
      const newHash = await computeHashHex(newStored);
      // Overwrite storage keys (this "forgets" the previous hash because it's overwritten)
      localStorage.setItem(BALANCE_KEY, newStored);
      localStorage.setItem(HASH_KEY, newHash);
      // no subscription notification here because numeric value didn't change
    } catch (e) {
      // ignore errors silently — if rolling fails, we don't want to crash
      // (optional: you can add console.warn here during debugging)
    }
  }, intervalMs);
}

export function stopHashRoller() {
  if (hashRollerTimer) {
    clearInterval(hashRollerTimer);
    hashRollerTimer = null;
  }
}

