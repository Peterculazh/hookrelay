import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Version,
} from '@nestjs/common';
import {
  EVENTS_SERVICE,
  type EventsService,
} from '../domain/interfaces/events.service.ts';
import { saveEventSchema, type SaveEventDto } from './dto/saveEvent.dto.ts';

@Controller()
export class EventsController {
  constructor(
    @Inject(EVENTS_SERVICE)
    private readonly eventsService: EventsService,
  ) {}

  @Version('1')
  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  saveEvent(@Body({ schema: saveEventSchema }) body: SaveEventDto) {
    return this.eventsService.saveEvent(body);
  }

  @Version('1')
  @Get('events/:id')
  getEvent(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.eventsService.getEvent(id);
  }
}
