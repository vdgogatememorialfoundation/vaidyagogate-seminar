<?php

namespace App\Gogate;

use Illuminate\Support\Facades\Http;
use Symfony\Component\Mailer\Exception\TransportException;
use Symfony\Component\Mailer\SentMessage;
use Symfony\Component\Mailer\Transport\AbstractTransport;
use Symfony\Component\Mime\Address;
use Symfony\Component\Mime\MessageConverter;

/**
 * Delivers Fleetbase mail through Zoho ZeptoMail HTTPS.
 * The send-mail token stays in a mode-600 seed file and never reaches the browser.
 */
class ZeptoMailTransport extends AbstractTransport
{
    public function __construct(private string $token, private string $apiUrl)
    {
        parent::__construct();
    }

    protected function doSend(SentMessage $message): void
    {
        $email = MessageConverter::toEmail($message->getOriginalMessage());
        $from = $email->getFrom()[0] ?? null;
        if (!$from instanceof Address || !filter_var($from->getAddress(), FILTER_VALIDATE_EMAIL)) {
            throw new TransportException('Fleetbase mail has no valid From address.');
        }

        $recipients = [];
        foreach ($email->getTo() as $addr) {
            if (!filter_var($addr->getAddress(), FILTER_VALIDATE_EMAIL)) {
                throw new TransportException('A recipient address is not a valid email.');
            }
            $recipients[] = [
                'email_address' => [
                    'address' => $addr->getAddress(),
                    'name' => $addr->getName() !== '' ? $addr->getName() : $addr->getAddress(),
                ],
            ];
        }
        if ($recipients === []) {
            throw new TransportException('The message has no recipients.');
        }

        $payload = [
            'from' => [
                'address' => $from->getAddress(),
                'name' => $from->getName() !== '' ? $from->getName() : 'Gogate Products',
            ],
            'to' => $recipients,
            'subject' => $email->getSubject() ?: 'Notification',
        ];
        $html = $email->getHtmlBody();
        $text = $email->getTextBody();
        if (is_string($html) && $html !== '') {
            $payload['htmlbody'] = $html;
        }
        if (is_string($text) && $text !== '') {
            $payload['textbody'] = $text;
        }
        if (!isset($payload['htmlbody']) && !isset($payload['textbody'])) {
            $payload['textbody'] = ' ';
        }

        $token = trim($this->token);
        $auth = preg_match('/^zoho-enczapikey\s/i', $token) === 1 ? $token : 'Zoho-enczapikey '.$token;
        $response = Http::withHeaders([
            'Authorization' => $auth,
            'Accept' => 'application/json',
        ])->timeout(25)->post($this->apiUrl, $payload);

        if (!$response->successful()) {
            throw new TransportException('ZeptoMail refused the message (HTTP '.$response->status().').');
        }
    }

    public function __toString(): string
    {
        return 'zeptomail';
    }
}
