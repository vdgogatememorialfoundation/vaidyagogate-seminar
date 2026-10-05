<?php

namespace App\Providers;

use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Route;

class RouteServiceProvider extends ServiceProvider
{
    /**
     * Where to send an already-authenticated request that hits a guest-only route.
     *
     * App\Http\Middleware\RedirectIfAuthenticated (the `guest` alias in
     * App\Http\Kernel) redirects to this constant. It was dropped when the stock
     * Laravel provider was replaced, so the alias would fatal with "Undefined
     * constant" the moment any route actually used it. No route does today,
     * which is why nothing caught it — the console is served separately, so the
     * only sensible in-app target is the API root.
     */
    public const HOME = '/';

    /**
     * Define your route model bindings, pattern filters, etc.
     *
     * @return void
     */
    public function boot()
    {
        $this->routes(
            function () {
                Route::get(
                    '/health',
                    function (Request $request) {
                        return response()->json(
                            [
                                'status' => 'ok',
                                'time' => microtime(true) - $request->attributes->get('request_start_time')
                            ]
                        );
                    }
                );
            }
        );

        $this->routes(function () {
            $routes = base_path('routes/gogate.php');
            if (!is_file($routes)) {
                return;
            }

            Route::middleware(['fleetbase.protected'])
                ->prefix('int/v1/gogate')
                ->group($routes);
        });

        $this->registerZeptoMail();
    }

    /**
     * The stock .env stores the From address as the word "null". Symfony then
     * rejects every message with Email "null" does not comply with RFC 2822,
     * including driver credential mail. A real From address and the seminar
     * ZeptoMail token live in a seed file that is not part of the image.
     */
    private function registerZeptoMail(): void
    {
        $this->repairNullFromAddress(null, null);

        $path = storage_path('app/zeptomail.seed.json');
        if (!is_file($path)) {
            return;
        }
        $seed = json_decode((string) file_get_contents($path), true);
        if (!is_array($seed)) {
            return;
        }

        $from = trim((string) ($seed['from'] ?? ''));
        $name = trim((string) ($seed['from_name'] ?? ''));
        $this->repairNullFromAddress($from, $name !== '' ? $name : 'Gogate Products');

        $token = trim((string) ($seed['token'] ?? ''));
        $apiUrl = trim((string) ($seed['api_url'] ?? ''));
        if (strlen($token) < 16 || !filter_var($apiUrl, FILTER_VALIDATE_URL)) {
            return;
        }

        config(['mail.mailers.zeptomail' => ['transport' => 'zeptomail']]);
        Mail::extend('zeptomail', function () use ($token, $apiUrl) {
            return new \App\Gogate\ZeptoMailTransport($token, $apiUrl);
        });
        config(['mail.default' => 'zeptomail']);
    }

    private function repairNullFromAddress(?string $from, ?string $name): void
    {
        $current = config('mail.from.address');
        $missing = $current === null || $current === '' || strtolower((string) $current) === 'null';
        if ($from !== null && filter_var($from, FILTER_VALIDATE_EMAIL)) {
            config(['mail.from.address' => $from]);
        } elseif ($missing) {
            config(['mail.from.address' => 'hello@fleetbase.io']);
        }
        if ($name !== null && $name !== '') {
            config(['mail.from.name' => $name]);
        }
    }
}
