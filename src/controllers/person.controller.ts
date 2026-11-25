import type { Request, Response } from "express";
import { getValidated } from "../middleware/validate.js";
import { personService } from "../services/person.service.js";
import { sendList, sendSuccess } from "../utils/http.js";
import { changePersonStatusRequest, createPersonRequest, getPersonRequest, listPersonsRequest, updatePersonRequest } from "../validators/person.js";
import { getActorId } from "./helpers.js";

async function createPerson(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, createPersonRequest);
  const person = await personService.createPerson(params.organizationId, body, getActorId(req));
  sendSuccess(res, 201, person, "Guest created");
}

async function listPersons(req: Request, res: Response): Promise<void> {
  const { params, query } = getValidated(req, listPersonsRequest);
  const { rows, count } = await personService.listPersons(params.organizationId, query);
  sendList(res, 200, rows, { count, page: query.page, pageSize: query.pageSize }, "Guests retrieved");
}

async function getPerson(req: Request, res: Response): Promise<void> {
  const { params } = getValidated(req, getPersonRequest);
  const person = await personService.getPerson(params.organizationId, params.personId);
  sendSuccess(res, 200, person, "Guest retrieved");
}

async function updatePerson(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, updatePersonRequest);
  const person = await personService.updatePerson(params.organizationId, params.personId, body, getActorId(req));
  sendSuccess(res, 200, person, "Guest updated");
}

async function changePersonStatus(req: Request, res: Response): Promise<void> {
  const { params, body } = getValidated(req, changePersonStatusRequest);
  const person = await personService.changePersonStatus(params.organizationId, params.personId, body.is_active, getActorId(req));
  sendSuccess(res, 200, person, "Guest status updated");
}

export const personController = { createPerson, listPersons, getPerson, updatePerson, changePersonStatus };
