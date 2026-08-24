// TimeSync: corrects the browser's local clock against an accurate,
// network-provided UTC time source, so the emitted radio signals reflect
// real time even if the user's system clock is off.
//
// NOTE ON SOURCE: time.gov's own client (see the "time.gov Archive" repo,
// https://github.com/robertlane0/time.gov) synchronizes by calling a
// same-origin NIST endpoint. That endpoint's own source code says plainly:
// "USE OF THIS .CGI BY OUTSIDE SITES OR APPLICATIONS IS STRICTLY
// PROHIBITED." It's also same-origin only, so a page hosted elsewhere
// couldn't reach it (no CORS) even if that notice weren't there. So rather
// than calling into that endpoint, this module reimplements time.gov's
// underlying technique -- send a request, note how long the round trip
// took, and assume the network delay was roughly symmetric to correct for
// it -- against public, CORS-enabled UTC time APIs instead.
//
// If every source fails, or the user opts out, `now()` simply returns the
// system clock unmodified.
window.TimeSync = (function() {
    var SOURCES = [
        {
            name: "worldtimeapi.org",
            url: "https://worldtimeapi.org/api/timezone/Etc/UTC",
            parse: function(json) { return json && json.unixtime ? json.unixtime * 1000 : NaN; }
        },
        {
            name: "timeapi.io",
            url: "https://timeapi.io/api/Time/current/zone?timeZone=UTC",
            parse: function(json) { return json && json.dateTime ? Date.parse(json.dateTime + "Z") : NaN; }
        }
    ];

    var REQUEST_TIMEOUT_MS = 5000;
    var RESYNC_INTERVAL_MS = 5 * 60 * 1000; // re-sync periodically to correct for drift

    var offset = 0;           // ms to add to Date.now() to get the corrected time
    var enabled = true;       // radio button state; defaults to opted-in
    var status = "syncing";   // syncing | synced | failed | disabled
    var lastRtt = null;
    var resyncTimer = null;
    var listeners = [];

    function notify() {
        var state = { status: status, offset: offset, rtt: lastRtt, enabled: enabled };
        listeners.forEach(function(fn) {
            try { fn(state); } catch (e) { /* ignore listener errors */ }
        });
    }

    // The corrected "now". Falls back to the untouched system clock whenever
    // sync is off or hasn't succeeded.
    function now() {
        var useOffset = enabled && status === "synced";
        return new Date(Date.now() + (useOffset ? offset : 0));
    }

    function fetchWithTimeout(url) {
        var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
        var timeoutId = controller && setTimeout(function() { controller.abort(); }, REQUEST_TIMEOUT_MS);
        return fetch(url, { cache: "no-store", signal: controller ? controller.signal : undefined })
            .then(function(res) {
                if (timeoutId) clearTimeout(timeoutId);
                if (!res.ok) throw new Error("bad status " + res.status);
                return res.json();
            })
            .catch(function(err) {
                if (timeoutId) clearTimeout(timeoutId);
                throw err;
            });
    }

    // Simplified NTP-style correction: t1 = request sent, t4 = response
    // received. We only get a single server timestamp back (not separate
    // receive/send times like full NTP), so we assume the network delay is
    // symmetric and add half the measured round trip to it.
    function trySource(source) {
        var t1 = Date.now();
        return fetchWithTimeout(source.url).then(function(json) {
            var t4 = Date.now();
            var serverMs = source.parse(json);
            if (!serverMs || isNaN(serverMs)) throw new Error("unexpected response shape");
            var rtt = t4 - t1;
            var estimatedServerNow = serverMs + rtt / 2;
            return { offset: estimatedServerNow - t4, rtt: rtt };
        });
    }

    function sync() {
        if (!enabled) return Promise.resolve();
        status = "syncing";
        notify();

        var chain = Promise.reject();
        SOURCES.forEach(function(source) {
            chain = chain.catch(function() { return trySource(source); });
        });

        return chain.then(function(result) {
            offset = result.offset;
            lastRtt = result.rtt;
            status = "synced";
            notify();
        }).catch(function() {
            offset = 0;
            lastRtt = null;
            status = "failed";
            notify();
        });
    }

    function setEnabled(nextEnabled) {
        enabled = nextEnabled;
        if (resyncTimer) {
            clearInterval(resyncTimer);
            resyncTimer = null;
        }
        if (enabled) {
            sync();
            resyncTimer = setInterval(sync, RESYNC_INTERVAL_MS);
        } else {
            offset = 0;
            status = "disabled";
            notify();
        }
    }

    function onChange(fn) {
        listeners.push(fn);
    }

    // --- UI wiring ---------------------------------------------------
    // Script tag is placed at the end of the document, so the markup above
    // it is already parsed and available.
    (function wireUI() {
        var radios = document.querySelectorAll('input[name="time-sync"]');
        var statusEl = document.getElementById("sync-status");

        function render(state) {
            if (!statusEl) return;
            var label;
            switch (state.status) {
                case "syncing":
                    label = "Syncing\u2026";
                    break;
                case "synced":
                    label = "Synced" + (state.rtt != null ? " (\u00B1" + Math.round(state.rtt / 2) + "ms)" : "");
                    break;
                case "failed":
                    label = "Sync failed \u2014 using system time";
                    break;
                case "disabled":
                default:
                    label = "Using system time";
                    break;
            }
            statusEl.textContent = label;
            statusEl.className = "sync-status status-" + state.status;
        }

        onChange(render);

        radios.forEach(function(radio) {
            radio.addEventListener("change", function() {
                if (this.checked) setEnabled(this.value === "yes");
            });
        });

        // Kick off the initial sync (radio defaults to "Yes" / opted in).
        setEnabled(true);
    })();

    return {
        now: now,
        sync: sync,
        setEnabled: setEnabled,
        onChange: onChange,
        isSynced: function() { return enabled && status === "synced"; }
    };
})();
