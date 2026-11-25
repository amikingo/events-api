import { smsConfig } from "../../config/sms.js";
import { afroMessageSmsSender } from "./afromessage.sender.js";
import { logSmsSender } from "./log.sender.js";
import type { SmsMessage, SmsSendResult, SmsSender } from "./sms-sender.js";

/** The sender chosen by SMS_DELIVERY. A new provider (Raven) is one more sender file and one more case here. */
function activeSender(): SmsSender {
  return smsConfig.delivery === "afromessage" ? afroMessageSmsSender : logSmsSender;
}

async function send(message: SmsMessage): Promise<SmsSendResult> {
  return activeSender().send(message);
}

export const smsClient = { send, senderName: () => activeSender().name };
