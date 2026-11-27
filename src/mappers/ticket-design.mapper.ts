import type { EventTicketDesignRow, TicketQrSize } from "../models/event-ticket-design.js";

type ImageDto = { url: string } | null;

/** The same shape for staff and for buyers: nothing in a design is private, it's printed on their tickets. */
export type TicketDesignDto = {
  design: string;
  color: string | null;
  note: string | null;
  show_price: boolean;
  show_venue: boolean;
  show_guest: boolean;
  /** Where the QR panel goes on custom artwork. */
  qr: { x: number; y: number; size: TicketQrSize };
  logo: ImageDto;
  picture: ImageDto;
  artwork: ImageDto;
  updated_at: Date;
};

/** `urls`: the public path of each of the design's files, by file id. */
export function toTicketDesignDto(row: EventTicketDesignRow, urls: ReadonlyMap<string, string>): TicketDesignDto {
  const image = (fileId: string | null | undefined): ImageDto => {
    const url = fileId ? urls.get(fileId) : undefined;
    return url ? { url } : null;
  };
  return {
    design: row.design,
    color: row.color,
    note: row.note,
    show_price: row.show_price,
    show_venue: row.show_venue,
    show_guest: row.show_guest,
    qr: { x: row.qr_x, y: row.qr_y, size: row.qr_size },
    logo: image(row.logo_file_id),
    picture: image(row.picture_file_id),
    artwork: image(row.artwork_file_id),
    updated_at: row.updated_at,
  };
}
