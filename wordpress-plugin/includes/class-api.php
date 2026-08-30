<?php

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Server-side HTTP client for the central push platform.
 * The secret API key is only ever used here, never exposed to browsers.
 */
final class MPP_API {

    /**
     * Create a campaign and kick off batch processing.
     *
     * @return array|WP_Error Campaign response array on success.
     */
    public static function create_campaign(array $payload, $idempotency_key = '') {
        $api_url = untrailingslashit((string) get_option('mpp_api_url'));
        $api_key = (string) get_option('mpp_api_key');

        if ($api_url === '' || $api_key === '') {
            return new WP_Error('push_not_configured', 'Push API URL or API key is missing.');
        }

        $headers = array(
            'Authorization' => 'Bearer ' . $api_key,
            'Content-Type'  => 'application/json',
            'Accept'        => 'application/json',
        );

        if ($idempotency_key) {
            $headers['Idempotency-Key'] = $idempotency_key;
        }

        $response = wp_remote_post($api_url . '/v1/campaigns', array(
            'timeout' => 10,
            'headers' => $headers,
            'body'    => wp_json_encode($payload),
        ));

        if (is_wp_error($response)) {
            return $response;
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        $body   = json_decode(wp_remote_retrieve_body($response), true);

        if ($status < 200 || $status >= 300 || !is_array($body)) {
            return new WP_Error(
                'push_api_error',
                sprintf('Push API returned HTTP %d.', $status)
            );
        }

        return $body;
    }

    /**
     * Kick off (or continue) resumable batch processing for a campaign.
     *
     * @return true|WP_Error
     */
    public static function start_processing($campaign_id) {
        $api_url = untrailingslashit((string) get_option('mpp_api_url'));
        $api_key = (string) get_option('mpp_api_key');

        if ($api_url === '' || $api_key === '') {
            return new WP_Error('push_not_configured', 'Push API URL or API key is missing.');
        }

        $response = wp_remote_post(
            $api_url . '/v1/campaigns/' . rawurlencode((string) $campaign_id) . '/process',
            array(
                'timeout' => 15,
                'headers' => array(
                    'Authorization' => 'Bearer ' . $api_key,
                ),
            )
        );

        if (is_wp_error($response)) {
            return $response;
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        if ($status < 200 || $status >= 300) {
            return new WP_Error(
                'push_api_error',
                sprintf('Could not start campaign processing (HTTP %d).', $status)
            );
        }

        return true;
    }

    /**
     * Fetch basic campaign status.
     *
     * @return array|WP_Error
     */
    public static function get_campaign($campaign_id) {
        $api_url = untrailingslashit((string) get_option('mpp_api_url'));
        $api_key = (string) get_option('mpp_api_key');

        if ($api_url === '' || $api_key === '') {
            return new WP_Error('push_not_configured', 'Push API URL or API key is missing.');
        }

        $response = wp_remote_get(
            $api_url . '/v1/campaigns/' . rawurlencode((string) $campaign_id),
            array(
                'timeout' => 10,
                'headers' => array(
                    'Authorization' => 'Bearer ' . $api_key,
                ),
            )
        );

        if (is_wp_error($response)) {
            return $response;
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        $body   = json_decode(wp_remote_retrieve_body($response), true);

        if ($status < 200 || $status >= 300 || !is_array($body)) {
            return new WP_Error('push_api_error', sprintf('HTTP %d', $status));
        }

        return $body;
    }
}
