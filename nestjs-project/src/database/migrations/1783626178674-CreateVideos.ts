import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateVideos1783626178674 implements MigrationInterface {
    name = 'CreateVideos1783626178674'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'failed')`);
        await queryRunner.query(`CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "title" character varying(255) NOT NULL, "url_id" character varying(21) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "storage_key" character varying NOT NULL, "thumbnail_key" character varying, "upload_id" character varying, "content_type" character varying(100) NOT NULL, "original_filename" character varying(255) NOT NULL, "size_bytes" bigint NOT NULL, "duration_seconds" integer, "metadata" jsonb, "error_message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_bebd291980f461ea34efae42703" UNIQUE ("url_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fa92ce74fa6331a7ad7743dea5" ON "videos" ("status", "created_at") `);
        await queryRunner.query(`ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fa92ce74fa6331a7ad7743dea5"`);
        await queryRunner.query(`DROP TABLE "videos"`);
        await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
    }

}
