<?php
/**
 * CloudPilot reseller API client used by the WHMCS modules.
 * Pure PHP + cURL; no WHMCS dependencies so it can be tested standalone.
 */

namespace CloudPilot\Whmcs;

class ApiException extends \Exception
{
    /** @var string */
    public $errorCode;
    /** @var int */
    public $httpStatus;

    public function __construct($message, $errorCode = 'error', $httpStatus = 0)
    {
        parent::__construct($message);
        $this->errorCode = $errorCode;
        $this->httpStatus = $httpStatus;
    }

    /** Network failures and 5xx responses are safe to retry (all writes are idempotent). */
    public function isRetryable()
    {
        return $this->httpStatus === 0 || $this->httpStatus >= 500 || $this->httpStatus === 429;
    }
}

class Client
{
    /** @var string */
    private $baseUrl;
    /** @var string */
    private $apiKey;
    /** @var int */
    private $timeout;
    /** @var int */
    private $retries;
    /** @var callable|null */
    private $logger;

    public function __construct($baseUrl, $apiKey, $timeout = 30, $retries = 2, $logger = null)
    {
        $baseUrl = rtrim(trim($baseUrl), '/');
        if (!preg_match('#^https?://#i', $baseUrl)) {
            $baseUrl = 'https://' . $baseUrl;
        }
        $this->baseUrl = $baseUrl;
        $this->apiKey = trim($apiKey);
        $this->timeout = max(5, (int) $timeout);
        $this->retries = max(0, (int) $retries);
        $this->logger = $logger;
    }

    /** Builds a client from WHMCS server-module params. */
    public static function fromParams(array $params)
    {
        $base = !empty($params['serveraccesshash']) ? $params['serveraccesshash'] : $params['serverhostname'];
        if (!preg_match('#^https?://#i', $base)) {
            $base = (!empty($params['serversecure']) ? 'https://' : 'http://') . $base;
        }
        $logger = function ($action, $request, $response) {
            if (function_exists('logModuleCall')) {
                // The API key is replaced so it never lands in the module log.
                logModuleCall('cloudpilot', $action, $request, $response, '', array());
            }
        };
        return new self($base, $params['serverpassword'], 30, 2, $logger);
    }

    /**
     * @param string $method
     * @param string $path    e.g. "v1/reseller/orders"
     * @param array|\stdClass|null $body
     * @param array $headers  extra headers, e.g. ['Idempotency-Key' => '...']
     * @return array decoded JSON
     * @throws ApiException
     */
    public function request($method, $path, $body = null, array $headers = array())
    {
        $url = $this->baseUrl . '/' . ltrim($path, '/');
        // Note: PHP encodes array() as [] — pass new \stdClass() for an empty JSON object.
        $payload = $body === null ? null : json_encode($body);
        $attempt = 0;
        while (true) {
            $attempt++;
            try {
                return $this->once($method, $url, $payload, $headers);
            } catch (ApiException $e) {
                if (!$e->isRetryable() || $attempt > $this->retries) {
                    throw $e;
                }
                usleep(250000 * $attempt * $attempt);
            }
        }
    }

    private function once($method, $url, $payload, array $headers)
    {
        $ch = curl_init($url);
        $h = array('Accept: application/json', 'Authorization: Bearer ' . $this->apiKey, 'User-Agent: CloudPilot-WHMCS/1.0');
        if ($payload !== null) {
            $h[] = 'Content-Type: application/json';
        }
        foreach ($headers as $k => $v) {
            $h[] = $k . ': ' . $v;
        }
        curl_setopt_array($ch, array(
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $h,
            CURLOPT_TIMEOUT => $this->timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_FOLLOWLOCATION => false,
        ));
        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        }
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($this->logger) {
            call_user_func($this->logger, $method . ' ' . parse_url($url, PHP_URL_PATH), $payload, $raw === false ? $err : $raw);
        }
        if ($raw === false) {
            throw new ApiException('Could not reach CloudPilot: ' . $err, 'network_error', 0);
        }
        $data = json_decode($raw, true);
        if ($status >= 400) {
            $msg = isset($data['error']['message']) ? $data['error']['message'] : ('HTTP ' . $status);
            $code = isset($data['error']['code']) ? $data['error']['code'] : 'http_' . $status;
            throw new ApiException($msg, $code, $status);
        }
        return is_array($data) ? $data : array();
    }

    // ───────── convenience wrappers

    public function heartbeat($siteUrl, $version)
    {
        return $this->request('POST', 'v1/reseller/integrations/heartbeat', array('platform' => 'WHMCS', 'version' => (string) $version, 'siteUrl' => (string) $siteUrl));
    }

    public function createOrder(array $order, $idempotencyKey)
    {
        return $this->request('POST', 'v1/reseller/orders', $order, array('Idempotency-Key' => $idempotencyKey));
    }

    public function orderByKey($key)
    {
        return $this->request('GET', 'v1/reseller/orders/by-key/' . rawurlencode($key));
    }

    public function serviceAction($serviceId, $action, $reason = null, $idempotencyKey = null)
    {
        $h = $idempotencyKey ? array('Idempotency-Key' => $idempotencyKey) : array();
        $body = $reason === null ? new \stdClass() : array('reason' => (string) $reason);
        return $this->request('POST', 'v1/reseller/services/' . rawurlencode($serviceId) . '/actions/' . $action, $body, $h);
    }

    public function renew($serviceId, $idempotencyKey)
    {
        return $this->request('POST', 'v1/reseller/services/' . rawurlencode($serviceId) . '/renew', new \stdClass(), array('Idempotency-Key' => $idempotencyKey));
    }

    public function serviceStatus($serviceId)
    {
        return $this->request('GET', 'v1/reseller/services/' . rawurlencode($serviceId) . '/status');
    }

    public function wallet()
    {
        return $this->request('GET', 'v1/reseller/wallet');
    }

    public function me()
    {
        return $this->request('GET', 'v1/reseller/me');
    }

    public function topup($gateway, $amountMinor, $externalRef)
    {
        return $this->request('POST', 'v1/reseller/wallet/topups', array('gateway' => $gateway, 'amountMinor' => (string) $amountMinor, 'externalRef' => $externalRef));
    }

    public function bankTransfer($amountMinor, $reference, $note)
    {
        return $this->request('POST', 'v1/reseller/wallet/bank-transfers', array('amountMinor' => (string) $amountMinor, 'bankReference' => $reference, 'note' => $note));
    }

    public function deposits()
    {
        return $this->request('GET', 'v1/reseller/wallet/deposits');
    }

    public function products()
    {
        return $this->request('GET', 'v1/reseller/products');
    }
}

/** Money helpers: CloudPilot uses integer minor units (paise/cents) as strings. */
function to_minor($amount)
{
    // number_format rounds to 2 decimals as a string, avoiding float artefacts like 899.99 * 100 = 89998.99999.
    $s = number_format((float) $amount, 2, '.', '');
    $negative = substr($s, 0, 1) === '-';
    $digits = ltrim(str_replace(array('-', '.'), '', $s), '0');
    return ($negative && $digits !== '' ? '-' : '') . ($digits === '' ? '0' : $digits);
}

function from_minor($minor)
{
    return number_format(((int) $minor) / 100, 2, '.', '');
}
