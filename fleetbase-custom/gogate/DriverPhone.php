<?php

namespace App\Gogate;

use Fleetbase\Models\User;

/**
 * Navigator sends the phone with a country code. The console stored this
 * driver's number as 10 local digits, so the lookup missed and the app said
 * no driver was found. Match the local number, a 91 prefix, and the +91 form.
 */
class DriverPhone
{
    public static function findDriverUser(?string $identity): ?User
    {
        $identity = trim((string) $identity);
        if ($identity === '') {
            return null;
        }

        $candidates = self::candidates($identity);
        $query = User::withoutGlobalScopes()
            ->whereNull('deleted_at')
            ->whereHas('driver');

        $query->where(function ($inner) use ($candidates, $identity) {
            $inner->whereIn('phone', $candidates);
            if (str_contains($identity, '@')) {
                $inner->orWhere('email', $identity);
            }
        });

        return $query->first();
    }

    /**
     * @return array<int, string>
     */
    public static function candidates(string $identity): array
    {
        $values = [$identity];
        $digits = preg_replace('/\D/', '', $identity) ?? '';
        if ($digits !== '') {
            $values[] = $digits;
            $values[] = '+'.$digits;
        }

        $local = null;
        if (strlen($digits) === 10) {
            $local = $digits;
        } elseif (strlen($digits) === 12 && str_starts_with($digits, '91')) {
            $local = substr($digits, 2);
        } elseif (strlen($digits) === 11 && str_starts_with($digits, '0')) {
            $local = substr($digits, 1);
        }

        if ($local !== null && strlen($local) === 10) {
            $values[] = $local;
            $values[] = '91'.$local;
            $values[] = '+91'.$local;
            $values[] = '+'.$local;
        }

        $unique = [];
        foreach ($values as $value) {
            $value = trim((string) $value);
            if ($value !== '') {
                $unique[$value] = true;
            }
        }

        return array_keys($unique);
    }
}
