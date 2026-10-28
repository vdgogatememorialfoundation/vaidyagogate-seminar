<?php

use App\Gogate\HubController;
use App\Gogate\RazorpayController;
use Illuminate\Support\Facades\Route;

Route::get('hubs', [HubController::class, 'index']);
Route::post('hubs', [HubController::class, 'store']);
Route::put('hubs/{id}', [HubController::class, 'update']);
Route::delete('hubs/{id}', [HubController::class, 'destroy']);

Route::get('razorpay', [RazorpayController::class, 'show']);
Route::post('razorpay', [RazorpayController::class, 'save']);
Route::post('razorpay/qr', [RazorpayController::class, 'qr']);
Route::get('razorpay/qr/{orderId}', [RazorpayController::class, 'qrStatus']);
