import { logger } from "../../utils/logger.js";
import { maskPhone, type SmsSender } from "./sms-sender.js";

/** SMS_DELIVERY=log (the default): nothing leaves the server; the text appears in the API log. */
export const logSmsSender: SmsSender = {
  name: "log",
  send({ to, text }) {
    logger.info({ to: maskPhone(to), text, length: text.length }, "SMS (log mode, not sent)");
    return Promise.resolve({ providerMessageId: null });
  },
};
