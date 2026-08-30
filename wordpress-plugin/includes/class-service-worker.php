<?php

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Serves the Web Push service worker at /push-sw.js on this site's origin.
 * Service workers are origin-scoped, so it must be served from WordPress.
 */
final class MPP_Service_Worker {

    public static function init() {
        add_action('init', array(__CLASS__, 'add_rewrite_rule'));
        add_filter('query_vars', array(__CLASS__, 'register_query_var'));
        add_action('template_redirect', array(__CLASS__, 'maybe_serve'));
    }

    public static function add_rewrite_rule() {
        add_rewrite_rule('^push-sw\.js$', 'index.php?mpp_service_worker=1', 'top');
    }

    public static function register_query_var($vars) {
        $vars[] = 'mpp_service_worker';
        return $vars;
    }

    public static function maybe_serve() {
        // Rewrite-rule route.
        if ((bool) get_query_var('mpp_service_worker')) {
            self::serve();
            return;
        }

        // Fallback for sites where rewrites are unavailable: /push-sw.js?mpp_service_worker=1
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended
        if (isset($_GET['mpp_service_worker'])) {
            self::serve();
        }
    }

    private static function serve() {
        header('Content-Type: application/javascript; charset=utf-8');
        header('Service-Worker-Allowed: /');
        header('Cache-Control: no-cache');

        $api_url = esc_js(untrailingslashit((string) get_option('mpp_api_url')));

        echo "const SW_API_URL = \"{$api_url}\";\n";

        echo <<<'SW'
self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "New notification", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "New notification";
  const options = {
    body: data.body || "",
    icon: data.icon || "/push-icon-192.png",
    badge: data.badge || undefined,
    image: data.image || undefined,
    tag: data.tag || undefined,
    data: { url: data.url || "/", campaignId: data.campaignId || null }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url =
    event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : "/";
  const campaignId =
    event.notification.data && event.notification.data.campaignId
      ? event.notification.data.campaignId
      : null;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ("focus" in client) {
          return client.focus().then(() => {
            if ("navigate" in client) return client.navigate(url);
          });
        }
      }
      if (clients.openWindow) {
        const target = campaignId && url.indexOf("?") === -1
          ? url + "?push_campaign=" + encodeURIComponent(campaignId)
          : url;
        return clients.openWindow(target);
      }
    })
  );

  // Best-effort click analytics.
  try {
    const siteKey = self.registration.scope;
    void fetch(SW_API_URL + "/v1/events", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteKey: new URL(self.registration.scope).host.replace(/^www\./, ""),
        event: "notification_click",
        campaignId: campaignId,
        url: url
      })
    }).catch(() => {});
  } catch (e) {}
});

self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil(
    self.registration.pushManager.getSubscription().then(sub => {
      // Re-sync handled by push-client.js on next visit; keep worker minimal.
      return sub;
    })
  );
});
SW;

        echo "\n";
    }
}
