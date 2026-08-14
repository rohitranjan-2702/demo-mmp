import Fastify from "fastify";
import { BatchBuffer, client, Events } from "./lib/clickhouse";
import { kafkaConsumer } from "./lib/kafka";

const fastify = Fastify({
  logger: true,
});

fastify.get("/", function (request, reply) {
  reply.send({ hello: "world" });
});

// one buffer for the whole process — do not create this per message
const batchBuff = new BatchBuffer(client, "events");

fastify.listen(
  { port: Number(process.env.PORT), host: "0.0.0.0" },
  async function (err, address) {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }

    await kafkaConsumer.connect();

    // events-topic may not exist yet on a fresh cluster (it's created lazily
    // when the producer sends its first message), so subscribe can throw
    // UNKNOWN_TOPIC_OR_PARTITION on startup — retry instead of crashing.
    const maxRetries = 10;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await kafkaConsumer.subscribe({
          topic: "events-topic",
          fromBeginning: true,
        });
        break;
      } catch (error) {
        if (attempt === maxRetries) {
          fastify.log.error(error, "failed to subscribe to events-topic");
          await kafkaConsumer.disconnect();
          process.exit(1);
        }
        fastify.log.warn(
          `subscribe attempt ${attempt} failed, retrying in 3s`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    try {
      await kafkaConsumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const row = JSON.parse(message.value?.toString() || "");
          batchBuff.add({ event_time: new Date(), ...row } as Events);

          console.log("msg added to batch buffer");
        },
      });
    } catch (error) {
      console.error(error);
    }
  },
);
