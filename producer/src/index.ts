import Fastify from "fastify";
import { kafkaProducer } from "./lib/kafka";

interface Body {
  id: number;
  event_type: string;
  user_id: number;
  page: string;
  country: string;
  duration_ms: number;
}

const fastify = Fastify({
  logger: true,
});

fastify.get("/", function (request, reply) {
  reply.send({ hello: "world" });
});

fastify.post("/event", async function (req, reply) {
  try {
    console.log("incoming event");
    const body = req.body as Body;

    // send to kafka
    const res = await kafkaProducer.send({
      topic: "events-topic",
      messages: [{ value: JSON.stringify(body) }],
    });

    console.log("msg produced", res);

    return Response.json({ success: true });
  } catch (error) {
    console.error(error);
    return Response.json({ success: false, error });
  }
});

fastify.listen(
  { port: Number(process.env.PORT), host: "0.0.0.0" },
  async function (err, address) {
    await kafkaProducer.connect();
    console.log("kafka connected");

    if (err) {
      fastify.log.error(err);
      await kafkaProducer.disconnect();
      process.exit(1);
    }
  },
);
