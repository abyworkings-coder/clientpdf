// Minimal, cookie-free visit counter — counts page loads and coarse referrer
// source only, no personal data. See README for what this does and why.
(function () {
  try {
    var ref = document.referrer;
    var bucket = "direct";
    if (ref) {
      bucket = /github\.com/i.test(ref) ? "github" : "other";
    }
    var base = "https://api.counterapi.dev/v1/clientpdf-abyworkings/";
    fetch(base + "visits-total/up", { mode: "no-cors" });
    fetch(base + "visits-" + bucket + "/up", { mode: "no-cors" });
  } catch (e) {
    // analytics must never break the tool
  }
})();
