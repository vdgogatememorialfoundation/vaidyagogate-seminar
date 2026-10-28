<?php

namespace App\Gogate;

use Fleetbase\FleetOps\Models\Order;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

class RazorpayController extends Controller
{
    public function show()
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }
        $this->importSeed($company);

        return response()->json($this->publicSettings($company));
    }

    public function save(Request $request)
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }
        $keyId = trim((string) $request->input('key_id'));
        $secret = trim((string) $request->input('key_secret'));
        if (!str_starts_with($keyId, 'rzp_live_') || strlen($secret) < 8) {
            return response()->json(['message' => 'Enter the live Razorpay key id and secret.'], 422);
        }
        $this->put($company, 'razorpay_key_id', $keyId);
        $this->put($company, 'razorpay_key_secret', $secret);

        return response()->json($this->publicSettings($company));
    }

    public function qr(Request $request)
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }
        $this->importSeed($company);
        $order = $this->findOrder($company, (string) $request->input('order'));
        if (!$order) {
            return response()->json(['message' => 'Shipment not found.'], 404);
        }
        $meta = $this->meta($order);
        if (empty($meta['cod'])) {
            return response()->json(['message' => 'Razorpay QR is only for a cash on delivery shipment.'], 422);
        }
        $keys = $this->keys($company);
        if (!$keys) {
            return response()->json(['message' => 'Razorpay live keys are not configured.'], 422);
        }
        $rupees = $this->amountRupees($order, $meta);
        $paise = (int) round($rupees * 100);
        if ($paise < 100) {
            return response()->json(['message' => 'This COD shipment has no amount to collect.'], 422);
        }
        if (!empty($meta['razorpay_qr_id'])) {
            $existing = $this->fetchQr($keys, (string) $meta['razorpay_qr_id']);
            if ($existing) {
                return response()->json($existing);
            }
        }

        $response = Http::withBasicAuth($keys['key_id'], $keys['key_secret'])
            ->acceptJson()
            ->timeout(20)
            ->post('https://api.razorpay.com/v1/payments/qr_codes', [
                'type' => 'upi_qr',
                'name' => mb_substr('Order ' . ($order->internal_id ?: $order->public_id), 0, 40),
                'usage' => 'single_use',
                'fixed_amount' => true,
                'payment_amount' => $paise,
                'description' => mb_substr('COD ' . ($order->internal_id ?: $order->public_id), 0, 40),
                'notes' => [
                    'order' => (string) $order->public_id,
                ],
            ]);
        if (!$response->successful() || !$response->json('id')) {
            return response()->json(['message' => $this->razorpayMessage($response->json())], 502);
        }
        $qr = $this->presentQr($response->json());
        $this->rememberQr($order, $meta, $qr);

        return response()->json($qr);
    }

    public function qrStatus(string $orderId)
    {
        Schema::ensure();
        $company = $this->companyUuid();
        if ($company instanceof \Illuminate\Http\JsonResponse) {
            return $company;
        }
        $order = $this->findOrder($company, $orderId);
        if (!$order) {
            return response()->json(['message' => 'Shipment not found.'], 404);
        }
        $meta = $this->meta($order);
        $qrId = (string) ($meta['razorpay_qr_id'] ?? '');
        if ($qrId === '') {
            return response()->json(['message' => 'This shipment has no Razorpay QR yet.'], 404);
        }
        $keys = $this->keys($company);
        if (!$keys) {
            return response()->json(['message' => 'Razorpay live keys are not configured.'], 422);
        }
        $qr = $this->fetchQr($keys, $qrId);
        if (!$qr) {
            return response()->json(['message' => 'Razorpay could not read this QR.'], 502);
        }
        $this->rememberQr($order, $meta, $qr);

        return response()->json($qr);
    }

    private function rememberQr(Order $order, array $meta, array $qr): void
    {
        $meta['razorpay_qr_id'] = $qr['id'];
        $meta['razorpay_qr_image'] = $qr['image_url'];
        $meta['cod_paid'] = $qr['paid'];
        if (method_exists($order, 'updateMeta')) {
            $order->updateMeta([
                'razorpay_qr_id' => $qr['id'],
                'razorpay_qr_image' => $qr['image_url'],
                'cod_paid' => $qr['paid'],
            ]);
            return;
        }
        $order->meta = $meta;
        $order->save();
    }

    private function fetchQr(array $keys, string $qrId): ?array
    {
        $response = Http::withBasicAuth($keys['key_id'], $keys['key_secret'])
            ->acceptJson()
            ->timeout(20)
            ->get('https://api.razorpay.com/v1/payments/qr_codes/' . rawurlencode($qrId));
        if (!$response->successful() || !$response->json('id')) {
            return null;
        }

        return $this->presentQr($response->json());
    }

    private function presentQr(array $qr): array
    {
        $due = (int) ($qr['payment_amount'] ?? 0);
        $got = (int) ($qr['payments_amount_received'] ?? 0);

        return [
            'id' => (string) ($qr['id'] ?? ''),
            'image_url' => (string) ($qr['image_url'] ?? ''),
            'status' => (string) ($qr['status'] ?? ''),
            'amount' => $due / 100,
            'amount_received' => $got / 100,
            'paid' => $due > 0 && $got >= $due,
        ];
    }

    private function razorpayMessage($json): string
    {
        $message = is_array($json) ? (string) data_get($json, 'error.description', '') : '';
        if ($message === '') {
            $message = 'Razorpay could not create a QR for this shipment.';
        }

        return mb_substr($message, 0, 240);
    }

    private function amountRupees(Order $order, array $meta): float
    {
        if (isset($meta['cod_amount']) && is_numeric($meta['cod_amount'])) {
            return (float) $meta['cod_amount'];
        }
        $order->loadMissing('payload.entities');
        $sum = 0.0;
        $entities = $order->payload ? $order->payload->entities : [];
        foreach ($entities as $entity) {
            $sum += (float) ($entity->price ?? 0);
        }
        if ($sum > 0) {
            return $sum;
        }

        return (float) ($order->transaction_amount ?? 0);
    }

    private function meta(Order $order): array
    {
        $meta = $order->meta;
        if (is_string($meta)) {
            $decoded = json_decode($meta, true);
            return is_array($decoded) ? $decoded : [];
        }

        return is_array($meta) ? $meta : [];
    }

    private function findOrder(string $company, string $id): ?Order
    {
        $id = trim($id);
        if ($id === '') {
            return null;
        }

        return Order::where('company_uuid', $company)
            ->where(function ($query) use ($id) {
                $query->where('public_id', $id)->orWhere('uuid', $id);
            })
            ->first();
    }

    private function keys(string $company): ?array
    {
        $keyId = (string) $this->get($company, 'razorpay_key_id');
        $secret = (string) $this->get($company, 'razorpay_key_secret');
        if (!str_starts_with($keyId, 'rzp_live_') || strlen($secret) < 8) {
            return null;
        }

        return ['key_id' => $keyId, 'key_secret' => $secret];
    }

    private function publicSettings(string $company): array
    {
        $keyId = (string) $this->get($company, 'razorpay_key_id');
        $configured = str_starts_with($keyId, 'rzp_live_') && strlen((string) $this->get($company, 'razorpay_key_secret')) >= 8;

        return [
            'configured' => $configured,
            'key_prefix' => $configured ? substr($keyId, 0, 12) : '',
        ];
    }

    private function importSeed(string $company): void
    {
        if ($this->keys($company)) {
            return;
        }
        $path = storage_path('app/razorpay.seed.json');
        if (!is_file($path)) {
            return;
        }
        $decoded = json_decode((string) file_get_contents($path), true);
        if (!is_array($decoded)) {
            return;
        }
        $keyId = trim((string) ($decoded['key_id'] ?? ''));
        $secret = trim((string) ($decoded['key_secret'] ?? ''));
        if (!str_starts_with($keyId, 'rzp_live_') || strlen($secret) < 8) {
            return;
        }
        $this->put($company, 'razorpay_key_id', $keyId);
        $this->put($company, 'razorpay_key_secret', $secret);
    }

    private function get(string $company, string $name): ?string
    {
        $row = DB::table('gogate_settings')->where('company_uuid', $company)->where('name', $name)->first();

        return $row ? (string) $row->value : null;
    }

    private function put(string $company, string $name, string $value): void
    {
        $existing = DB::table('gogate_settings')->where('company_uuid', $company)->where('name', $name)->first();
        if ($existing) {
            DB::table('gogate_settings')->where('id', $existing->id)->update([
                'value' => $value,
                'updated_at' => now(),
            ]);
            return;
        }
        DB::table('gogate_settings')->insert([
            'company_uuid' => $company,
            'name' => $name,
            'value' => $value,
            'updated_at' => now(),
        ]);
    }

    private function companyUuid()
    {
        $company = session('company');
        if (is_object($company) && isset($company->uuid)) {
            $company = $company->uuid;
        }
        if (!is_string($company) || $company === '') {
            return response()->json(['message' => 'Sign in again.'], 401);
        }

        return $company;
    }
}
