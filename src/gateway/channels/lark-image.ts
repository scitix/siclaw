export async function replyImageToLark(
  larkClient: any,
  messageId: string,
  image: Buffer,
): Promise<boolean> {
  try {
    const imageApi = larkClient?.im?.image ?? larkClient?.im?.v1?.image;
    if (!imageApi?.create) {
      console.error("[lark-image] im.image.create is unavailable; cannot upload chart image");
      return false;
    }

    const upload = await imageApi.create({
      data: {
        image_type: "message",
        image,
      },
    });
    const imageKey = upload?.image_key ?? upload?.data?.image_key;
    if (!imageKey || typeof imageKey !== "string") {
      console.error("[lark-image] image upload returned no image_key");
      return false;
    }

    await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
    return true;
  } catch (err) {
    console.error(`[lark-image] reply image failed for messageId=${messageId}:`, err);
    return false;
  }
}
