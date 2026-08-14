// produces message to kafka
import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "consumer-x",
  brokers: [process.env.KAFKA_BROKER!],
});

export const kafkaConsumer = kafka.consumer({ groupId: "events-group" });
